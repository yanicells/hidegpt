import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { CodexSession, accountLabel, formFields, inputQuestions, type Snapshot } from '../codex/session'
import type { Block } from '../codex/blocks'
import { C, FONT, LIGHT, PAGE_WIDTH, TITLEBAR, HOME_MAX, CARD_COLS, CARD_ROW_H, TEMPLATE_H, THUMB_H, CARD_W, SHADOW, SHADOW_HOVER } from './theme'

type MenuId = 'file' | 'edit' | 'view' | 'tools' | 'account' | 'model' | 'effort' | 'mode' | null

export function AppRoot({ session }: { session: CodexSession }) {
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [menu, setMenu] = useState<MenuId>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    void session.start()
    return () => {
      void session.close()
    }
  }, [session])

  useEffect(() => {
    setDraft('')
  }, [snap.route.kind, snap.route.kind === 'doc' ? snap.route.threadId : null])

  const closeMenu = () => setMenu(null)
  const toggle = (id: MenuId) => setMenu((current) => (current === id ? null : id))

  return (
    <div
      testId="app"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        backgroundColor: C.chrome,
      }}
    >
      <Menubar snap={snap} session={session} menu={menu} toggle={toggle} />
      {menu && menu !== 'model' && menu !== 'effort' && menu !== 'mode' ? (
        <MenuPanel snap={snap} session={session} menu={menu} onClose={closeMenu} />
      ) : null}
      {snap.route.kind === 'home' ? (
        <HomeSearch snap={snap} session={session} />
      ) : (
        <Toolbar snap={snap} session={session} menu={menu} toggle={toggle} onClose={closeMenu} />
      )}
      {snap.showFolder ? <FolderBar session={session} snap={snap} /> : null}
      {snap.requiresAuth && snap.status === 'ready' && !snap.account ? (
        <Banner
          testId="auth-banner"
          text="Sign in with ChatGPT to use Docs."
          action="Sign in"
          onAction={() => void session.login()}
        />
      ) : null}
      {snap.status === 'ready'
        ? toolsNeedingConnect(snap.mcpServers).map((server) => (
            <Banner
              key={server.name}
              testId={`mcp-banner-${server.name}`}
              text={`${displayServerName(server.name)} needs to be reconnected.`}
              action="Connect"
              onAction={() => void session.connectMcp(server.name)}
            />
          ))
        : null}
      {snap.loginUrl && snap.status === 'ready' ? (
        <Banner testId="login-url" text={snap.loginUrl} />
      ) : null}
      {snap.error && snap.status === 'ready' ? (
        <Banner testId="error-banner" text={snap.error} danger />
      ) : null}
      {snap.status === 'connecting' ? (
        <Status text="Opening…" />
      ) : snap.status === 'error' ? (
        <Status text={snap.error ?? 'Something went wrong'} onClick={() => void session.start()} />
      ) : snap.route.kind === 'home' ? (
        <Home snap={snap} session={session} />
      ) : (
        <Document
          snap={snap}
          session={session}
          draft={draft}
          setDraft={setDraft}
        />
      )}
    </div>
  )
}

function Menubar({
  snap,
  session,
  menu,
  toggle,
}: {
  snap: Snapshot
  session: CodexSession
  menu: MenuId
  toggle: (id: MenuId) => void
}) {
  return (
    <div
      style={{
        paddingTop: TITLEBAR,
        backgroundColor: C.chrome,
        borderBottomWidth: 1,
        borderColor: C.menuLine,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          height: 40,
          paddingLeft: 78,
          paddingRight: 16,
        }}
      >
      <DocsWordmark />
      <MenuLabel id="file" label="File" menu={menu} toggle={toggle} />
      <MenuLabel id="edit" label="Edit" menu={menu} toggle={toggle} />
      <MenuLabel id="view" label="View" menu={menu} toggle={toggle} />
      <MenuLabel id="tools" label="Tools" menu={menu} toggle={toggle} />
      <div style={{ flexGrow: 1 }} />
      <MenuLabel id="account" label={snap.status === 'connecting' ? '…' : accountLabel(snap.account)} menu={menu} toggle={toggle} />
      </div>
    </div>
  )
}

function MenuLabel({
  id,
  label,
  menu,
  toggle,
}: {
  id: MenuId
  label: string
  menu: MenuId
  toggle: (id: MenuId) => void
}) {
  const active = menu === id
  return (
    <div
      testId={`menu-${id}`}
      onClick={() => toggle(id)}
      style={{
        paddingLeft: 10,
        paddingRight: 10,
        height: 24,
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        cursor: 'pointer',
        backgroundColor: active ? C.chip : undefined,
        hover: { backgroundColor: C.chip },
      }}
    >
      <text style={{ fontSize: 13, fontFamily: FONT, color: C.text }}>{label}</text>
    </div>
  )
}

function MenuPanel({
  snap,
  session,
  menu,
  onClose,
}: {
  snap: Snapshot
  session: CodexSession
  menu: Exclude<MenuId, 'model' | 'effort' | 'mode' | null>
  onClose: () => void
}) {
  const items =
    menu === 'file'
      ? [
          { id: 'new', label: 'New document', run: () => void session.newDocument() },
          { id: 'home', label: 'Open home', run: () => session.goHome() },
          { id: 'folder', label: 'Open folder…', run: () => session.toggleFolder(true) },
        ]
      : menu === 'account'
        ? snap.account
          ? [{ id: 'logout', label: 'Log out', run: () => void session.logout() }]
          : [{ id: 'login', label: 'Log in with ChatGPT', run: () => void session.login() }]
        : menu === 'tools'
          ? [
              { id: 'refresh', label: 'Refresh from Codex', run: () => void session.start().then(() => session.refreshCatalog()) },
              ...snap.mcpServers.filter(needsReconnect).map((server) => ({
                  id: `mcp-${server.name}`,
                  label: `Connect ${server.name}`,
                  run: () => void session.connectMcp(server.name),
                })),
            ]
          : [{ id: 'home', label: 'Home', run: () => session.goHome() }]

  return (
    <div
      testId={`panel-${menu}`}
      style={{
        backgroundColor: C.page,
        borderBottomWidth: 1,
        borderColor: C.line,
        paddingTop: 4,
        paddingBottom: 4,
        paddingLeft: 78,
        flexShrink: 0,
      }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          testId={`action-${item.id}`}
          onClick={() => {
            item.run()
            onClose()
          }}
          style={{
            height: 28,
            paddingLeft: 10,
            paddingRight: 10,
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            hover: { backgroundColor: C.chipActive },
          }}
        >
          <text style={{ fontSize: 13, fontFamily: FONT, color: C.text }}>{item.label}</text>
        </div>
      ))}
    </div>
  )
}

function Toolbar({
  snap,
  session,
  menu,
  toggle,
  onClose,
}: {
  snap: Snapshot
  session: CodexSession
  menu: MenuId
  toggle: (id: MenuId) => void
  onClose: () => void
}) {
  const model = snap.models.find((item) => item.model === snap.model)
  const efforts = model?.supportedReasoningEfforts ?? []
  const used = snap.rateLimits?.rateLimits.primary
    ? `${Math.round(snap.rateLimits.rateLimits.primary.usedPercent)}%`
    : null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        backgroundColor: C.chrome,
        borderBottomWidth: 1,
        borderColor: C.line,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          height: 40,
          paddingLeft: 12,
          paddingRight: 12,
          gap: 8,
        }}
      >
        <Chip
          testId="chip-model"
          label={model?.displayName ?? snap.model ?? 'Model'}
          open={menu === 'model'}
          onClick={() => toggle('model')}
        />
        {efforts.length > 0 ? (
          <Chip
            testId="chip-effort"
            label={snap.effort ?? 'Effort'}
            open={menu === 'effort'}
            onClick={() => toggle('effort')}
          />
        ) : null}
        {snap.collaborationModes.length > 0 ? (
          <Chip
            testId="chip-mode"
            label={snap.collaborationMode ?? 'Mode'}
            open={menu === 'mode'}
            onClick={() => toggle('mode')}
          />
        ) : null}
        <div style={{ flexGrow: 1 }} />
        {used ? <text style={{ fontSize: 12, fontFamily: FONT, color: C.muted }}>{used}</text> : null}
      </div>
      {menu === 'model' ? (
        <ChipList
          items={snap.models.map((item) => ({ id: item.model, label: item.displayName }))}
          onPick={(id) => {
            session.setModel(id)
            onClose()
          }}
        />
      ) : null}
      {menu === 'effort' ? (
        <ChipList
          items={efforts.map((item) => ({ id: item.reasoningEffort, label: item.reasoningEffort }))}
          onPick={(id) => {
            session.setEffort(id)
            onClose()
          }}
        />
      ) : null}
      {menu === 'mode' ? (
        <ChipList
          items={snap.collaborationModes.map((item) => ({ id: item.name, label: item.name }))}
          onPick={(id) => {
            session.setCollaborationMode(id)
            onClose()
          }}
        />
      ) : null}
    </div>
  )
}

function Chip({
  label,
  open,
  onClick,
  testId,
}: {
  label: string
  open: boolean
  onClick: () => void
  testId: string
}) {
  return (
    <div
      testId={testId}
      onClick={onClick}
      style={{
        height: 28,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 4,
        backgroundColor: open ? C.chipActive : C.chip,
        display: 'flex',
        alignItems: 'center',
        cursor: 'pointer',
        hover: { backgroundColor: C.chipActive },
      }}
    >
      <text style={{ fontSize: 13, fontFamily: FONT, color: C.text }}>{label}</text>
    </div>
  )
}

function ChipList({
  items,
  onPick,
}: {
  items: { id: string; label: string }[]
  onPick: (id: string) => void
}) {
  return (
    <div style={{ paddingLeft: 12, paddingRight: 12, paddingBottom: 8 }}>
      {items.map((item) => (
        <div
          key={item.id}
          testId={`pick-${item.id}`}
          onClick={() => onPick(item.id)}
          style={{
            height: 28,
            paddingLeft: 10,
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            hover: { backgroundColor: C.chipActive },
          }}
        >
          <text style={{ fontSize: 13, fontFamily: FONT, color: C.text }}>{item.label}</text>
        </div>
      ))}
    </div>
  )
}

function FolderBar({ session, snap }: { session: CodexSession; snap: Snapshot }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 8,
        paddingBottom: 8,
        backgroundColor: C.page,
        borderBottomWidth: 1,
        borderColor: C.line,
        flexShrink: 0,
      }}
    >
      <text style={{ fontSize: 13, fontFamily: FONT, color: C.secondary }}>Folder</text>
      <input
        testId="folder-path"
        value={snap.folderDraft}
        onChange={(event) => session.setFolderDraft(event.value ?? '')}
        onSubmit={() => session.applyFolder()}
        theme={LIGHT}
        style={{ flexGrow: 1, fontSize: 13, fontFamily: FONT, color: C.text }}
      />
      <div
        testId="folder-apply"
        onClick={() => session.applyFolder()}
        style={{
          height: 28,
          paddingLeft: 12,
          paddingRight: 12,
          borderRadius: 4,
          backgroundColor: C.blue,
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
        }}
      >
        <text style={{ fontSize: 13, fontFamily: FONT, color: C.page }}>Use</text>
      </div>
      <div
        testId="folder-cancel"
        onClick={() => session.toggleFolder(false)}
        style={{
          height: 28,
          paddingLeft: 12,
          paddingRight: 12,
          borderRadius: 4,
          backgroundColor: C.chip,
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
        }}
      >
        <text style={{ fontSize: 13, fontFamily: FONT, color: C.text }}>Cancel</text>
      </div>
    </div>
  )
}

function Banner({
  text,
  testId,
  danger,
  action,
  onAction,
}: {
  text: string
  testId: string
  danger?: boolean
  action?: string
  onAction?: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 8,
        paddingBottom: 8,
        backgroundColor: C.gallery,
        gap: 8,
        flexShrink: 0,
      }}
    >
      <text
        testId={testId}
        style={{
          fontSize: 12,
          fontFamily: FONT,
          color: danger ? C.danger : C.secondary,
          flexGrow: 1,
        }}
      >
        {text}
      </text>
      {action && onAction ? (
        <div onClick={onAction} style={{ cursor: 'pointer' }}>
          <text style={{ fontSize: 12, fontFamily: FONT, color: C.blue }}>{action}</text>
        </div>
      ) : null}
    </div>
  )
}

function HomeSearch({ snap, session }: { snap: Snapshot; session: CodexSession }) {
  return (
    <div
      style={{
        backgroundColor: C.header,
        paddingTop: 4,
        paddingBottom: 10,
        paddingLeft: 160,
        paddingRight: 160,
        borderBottomWidth: 1,
        borderColor: C.menuLine,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          backgroundColor: C.search,
          borderRadius: 8,
          height: 42,
          paddingLeft: 16,
          paddingRight: 16,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <input
          testId="home-search"
          value={snap.search}
          placeholder="Search documents"
          onChange={(event) => session.setSearch(event.value ?? '')}
          onSubmit={() => void session.applySearch()}
          theme={LIGHT}
          style={{ flexGrow: 1, fontSize: 16, fontFamily: FONT, color: C.text }}
        />
      </div>
    </div>
  )
}

function DocsWordmark() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: 20,
        gap: 10,
      }}
    >
      <div
        style={{
          width: 28,
          height: 36,
          borderRadius: 2,
          backgroundColor: C.page,
          borderWidth: 1,
          borderColor: C.line,
          overflow: 'hidden',
        }}
      >
        <div style={{ height: 10, backgroundColor: C.blue }} />
        <div style={{ height: 2, backgroundColor: C.line, marginTop: 5, marginLeft: 5, marginRight: 5 }} />
        <div style={{ height: 2, backgroundColor: C.line, marginTop: 3, marginLeft: 5, marginRight: 8 }} />
        <div style={{ height: 2, backgroundColor: C.line, marginTop: 3, marginLeft: 5, marginRight: 6 }} />
      </div>
      <text style={{ fontSize: 22, fontFamily: FONT, color: C.secondary }}>Docs</text>
    </div>
  )
}

function Status({ text, onClick }: { text: string; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        flexGrow: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: C.surround,
        cursor: onClick ? 'pointer' : undefined,
      }}
    >
      <text testId="status" style={{ fontSize: 14, fontFamily: FONT, color: C.secondary }}>
        {text}
      </text>
    </div>
  )
}

function Home({ snap, session }: { snap: Snapshot; session: CodexSession }) {
  const grouped = useMemo(() => {
    const query = snap.search.trim().toLowerCase()
    const visible = query
      ? snap.threads.filter((thread) => {
          const title = `${thread.name ?? ''} ${thread.preview}`.toLowerCase()
          return title.includes(query)
        })
      : snap.threads
    const byProject = new Map<string, typeof snap.threads>()
    const loose: typeof snap.threads = []
    for (const thread of visible) {
      if (thread.projectId) {
        const list = byProject.get(thread.projectId) ?? []
        list.push(thread)
        byProject.set(thread.projectId, list)
      } else {
        loose.push(thread)
      }
    }
    const known = new Set(snap.projects.map((project) => project.id))
    const orphans = [...byProject.entries()].filter(([id]) => !known.has(id))
    return { byProject, loose, orphans }
  }, [snap.threads, snap.projects, snap.search])

  const sections: Array<{ key: string; title: string; threads: typeof snap.threads }> = [
    ...snap.projects.map((project) => ({
      key: `p-${project.id}`,
      title: project.name,
      threads: grouped.byProject.get(project.id) ?? [],
    })),
    ...grouped.orphans.map(([id, threads]) => ({
      key: `orphan-${id}`,
      title: 'Folder',
      threads,
    })),
    { key: 'recent', title: 'Recent documents', threads: grouped.loose },
  ]

  const items: Array<
    | { key: string; kind: 'gallery' }
    | { key: string; kind: 'heading'; title: string }
    | { key: string; kind: 'empty'; text: string }
    | { key: string; kind: 'row'; threads: typeof snap.threads }
  > = [{ key: 'gallery', kind: 'gallery' }]

  for (const section of sections) {
    if (section.threads.length === 0 && section.key !== 'recent') continue
    items.push({ key: `${section.key}-h`, kind: 'heading', title: section.title })
    if (section.threads.length === 0) {
      items.push({
        key: `${section.key}-empty`,
        kind: 'empty',
        text:
          snap.threads.length === 0
            ? 'No documents yet'
            : snap.search.trim()
              ? 'No matching documents'
              : 'All documents are in folders',
      })
      continue
    }
    chunk(section.threads, CARD_COLS).forEach((row, index) => {
      items.push({ key: `${section.key}-row-${index}`, kind: 'row', threads: row })
    })
  }

  return (
    <virtual-list
      estimatedItemHeight={CARD_ROW_H}
      style={{ flexGrow: 1, minHeight: 0, backgroundColor: C.surround }}
    >
      {items.map((item) => {
        if (item.kind === 'gallery') {
          return (
            <div
              key={item.key}
              style={{
                backgroundColor: C.gallery,
                paddingTop: 28,
                paddingBottom: 28,
                height: TEMPLATE_H,
              }}
            >
              <div style={{ width: HOME_MAX, paddingLeft: 48 }}>
                <text
                  testId="docs-home"
                  style={{
                    fontSize: 16,
                    fontFamily: FONT,
                    color: C.secondary,
                    paddingBottom: 16,
                    fontWeight: 500,
                  }}
                >
                  Start a new document
                </text>
                <div
                  testId="new-doc"
                  onClick={() => void session.newDocument()}
                  style={{
                    width: 126,
                    height: 158,
                    borderRadius: 2,
                    borderWidth: 1,
                    borderColor: C.line,
                    backgroundColor: C.page,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    boxShadow: SHADOW,
                    hover: { borderColor: C.blue, boxShadow: SHADOW_HOVER },
                  }}
                >
                  <text style={{ fontSize: 40, fontFamily: FONT, color: C.blue, pointerEvents: 'none' }}>+</text>
                </div>
                <text style={{ fontSize: 13, fontFamily: FONT, color: C.text, paddingTop: 10 }}>Blank</text>
              </div>
            </div>
          )
        }
        if (item.kind === 'heading') {
          return (
            <div
              key={item.key}
              style={{
                backgroundColor: C.page,
                paddingLeft: 48,
                paddingRight: 48,
                paddingTop: 24,
                paddingBottom: 12,
                height: 56,
              }}
            >
              <text style={{ fontSize: 16, fontFamily: FONT, color: C.secondary, fontWeight: 500 }}>
                {item.title}
              </text>
            </div>
          )
        }
        if (item.kind === 'empty') {
          return (
            <div key={item.key} style={{ backgroundColor: C.page, paddingLeft: 48, paddingBottom: 32, height: 48 }}>
              <text style={{ fontSize: 13, fontFamily: FONT, color: C.muted }}>{item.text}</text>
            </div>
          )
        }
        return (
          <div
            key={item.key}
            style={{
              backgroundColor: C.page,
              width: HOME_MAX,
              paddingLeft: 48,
              paddingRight: 48,
              paddingBottom: 8,
              display: 'flex',
              flexDirection: 'row',
              gap: 16,
              height: CARD_ROW_H,
            }}
          >
            {item.threads.map((thread) => (
              <DocCard key={thread.id} thread={thread} onOpen={() => void session.openThread(thread.id)} />
            ))}
          </div>
        )
      })}
    </virtual-list>
  )
}

function DocCard({
  thread,
  onOpen,
}: {
  thread: Snapshot['threads'][number]
  onOpen: () => void
}) {
  const title = thread.name?.trim() || thread.preview?.trim() || 'Untitled document'
  const preview = thread.preview?.trim() || title
  return (
    <div
      testId={`thread-${thread.id}`}
      onClick={onOpen}
      style={{
        width: CARD_W,
        display: 'flex',
        flexDirection: 'column',
        cursor: 'pointer',
      }}
    >
      <div
        style={{
          height: THUMB_H,
          borderRadius: 2,
          borderWidth: 1,
          borderColor: C.line,
          backgroundColor: C.page,
          paddingLeft: 14,
          paddingRight: 14,
          paddingTop: 14,
          paddingBottom: 14,
          pointerEvents: 'none',
          boxShadow: SHADOW,
          hover: { borderColor: C.blue, boxShadow: SHADOW_HOVER },
        }}
      >
        <text
          style={{
            fontSize: 11,
            fontFamily: FONT,
            color: C.muted,
            lineHeight: 16,
          }}
        >
          {preview.length > 180 ? `${preview.slice(0, 180)}…` : preview}
        </text>
      </div>
      <text
        style={{
          fontSize: 13,
          fontFamily: FONT,
          color: C.text,
          paddingTop: 10,
          fontWeight: 500,
        }}
      >
        {title}
      </text>
      <text style={{ fontSize: 12, fontFamily: FONT, color: C.muted, paddingTop: 2 }}>
        {formatOpened(thread.recencyAt ?? thread.updatedAt)}
      </text>
    </div>
  )
}

function Document({
  snap,
  session,
  draft,
  setDraft,
}: {
  snap: Snapshot
  session: CodexSession
  draft: string
  setDraft: (value: string) => void
}) {
  const submit = () => {
    if (snap.streaming) return
    const text = draft
    setDraft('')
    void session.send(text)
  }

  return (
    <div
      testId="document"
      style={{
        flexGrow: 1,
        minHeight: 0,
        backgroundColor: C.surround,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      <virtual-list
        estimatedItemHeight={80}
        followTail={snap.streaming}
        style={{
          width: PAGE_WIDTH,
          flexGrow: 1,
          minHeight: 0,
          backgroundColor: C.page,
          paddingLeft: 72,
          paddingRight: 72,
          paddingTop: 56,
          paddingBottom: 8,
          boxShadow: SHADOW,
        }}
      >
        <div key="title" style={{ paddingBottom: 28 }}>
          <text style={{ fontSize: 34, fontFamily: FONT, color: C.text, lineHeight: 40 }}>{snap.title}</text>
        </div>
        {snap.olderTurnsCursor ? (
          <div
            key="older"
            testId="load-older"
            onClick={() => void session.loadOlderTurns()}
            style={{ paddingBottom: 16, cursor: 'pointer' }}
          >
            <text style={{ fontSize: 13, fontFamily: FONT, color: C.blue }}>
              {snap.loadingOlder ? 'Loading…' : 'Load earlier'}
            </text>
          </div>
        ) : null}
        {snap.blocks.map((block) => (
          <div key={block.id} style={{ paddingBottom: 16 }}>
            <BlockView block={block} session={session} />
          </div>
        ))}
      </virtual-list>
      <div
        style={{
          width: PAGE_WIDTH,
          backgroundColor: C.page,
          paddingLeft: 72,
          paddingRight: 72,
          paddingTop: 8,
          paddingBottom: 24,
          flexShrink: 0,
        }}
      >
        {snap.streaming ? (
          <div
            testId="stop-turn"
            onClick={() => void session.interrupt()}
            style={{
              height: 28,
              paddingLeft: 12,
              paddingRight: 12,
              marginBottom: 8,
              borderRadius: 4,
              backgroundColor: C.chip,
              display: 'flex',
              alignItems: 'center',
              alignSelf: 'flex-start',
              cursor: 'pointer',
              hover: { backgroundColor: C.chipActive },
            }}
          >
            <text style={{ fontSize: 13, fontFamily: FONT, color: C.text }}>Stop</text>
          </div>
        ) : null}
        <textarea
          testId="composer"
          value={draft}
          placeholder={snap.streaming ? 'Working…' : 'Type a question'}
          minRows={1}
          maxRows={8}
          onChange={(event) => setDraft(event.value ?? '')}
          onSubmit={submit}
          theme={LIGHT}
          style={{ fontSize: 15, fontFamily: FONT, color: C.text, lineHeight: 24 }}
        />
      </div>
    </div>
  )
}

function BlockView({ block, session }: { block: Block; session: CodexSession }) {
  if (block.kind === 'user') {
    return <text style={{ fontSize: 18, fontFamily: FONT, color: C.text, lineHeight: 26 }}>{block.text}</text>
  }
  if (block.kind === 'agent') {
    return <markdown source={block.text} theme={LIGHT} />
  }
  if (block.kind === 'callout') {
    return (
      <div
        style={{
          backgroundColor: C.callout,
          borderWidth: 1,
          borderColor: C.line,
          borderRadius: 4,
          paddingLeft: 12,
          paddingRight: 12,
          paddingTop: 8,
          paddingBottom: 8,
        }}
      >
        <text style={{ fontSize: 12, fontFamily: FONT, color: C.secondary, paddingBottom: 4 }}>
          {block.title}
        </text>
        {block.body ? (
          <text style={{ fontSize: 13, fontFamily: FONT, color: C.text }}>{block.body}</text>
        ) : null}
      </div>
    )
  }
  const fields = formFields(block)
  const questions = inputQuestions(block)
  return (
    <div
      testId={`approval-${block.id}`}
      style={{
        backgroundColor: C.approval,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: 4,
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 10,
        paddingBottom: 10,
      }}
    >
      <text style={{ fontSize: 14, fontFamily: FONT, color: C.text, paddingBottom: 4 }}>{block.title}</text>
      <text style={{ fontSize: 13, fontFamily: FONT, color: C.secondary, paddingBottom: 8 }}>{block.body}</text>
      {!block.resolved
        ? fields.map((field) => (
            <div key={field.key} style={{ paddingBottom: 8 }}>
              <text style={{ fontSize: 12, fontFamily: FONT, color: C.secondary, paddingBottom: 4 }}>
                {field.label}
              </text>
              <input
                testId={`draft-${block.id}-${field.key}`}
                value={block.drafts[field.key] ?? ''}
                onChange={(event) => session.setApprovalDraft(block.id, field.key, event.value ?? '')}
                theme={LIGHT}
                style={{ fontSize: 13, fontFamily: FONT, color: C.text }}
              />
            </div>
          ))
        : null}
      {!block.resolved
        ? questions.map((question) => (
            <div key={question.id} style={{ paddingBottom: 8 }}>
              <text style={{ fontSize: 13, fontFamily: FONT, color: C.text, paddingBottom: 4 }}>
                {question.question}
              </text>
              <div style={{ display: 'flex', flexDirection: 'row', gap: 6 }}>
                {(question.options ?? []).map((option) => (
                  <div
                    key={option.label}
                    onClick={() => session.setApprovalDraft(block.id, question.id, option.label)}
                    style={{
                      height: 24,
                      paddingLeft: 8,
                      paddingRight: 8,
                      borderRadius: 4,
                      backgroundColor: block.drafts[question.id] === option.label ? C.chipActive : C.chip,
                      display: 'flex',
                      alignItems: 'center',
                      cursor: 'pointer',
                    }}
                  >
                    <text style={{ fontSize: 12, fontFamily: FONT, color: C.text }}>{option.label}</text>
                  </div>
                ))}
              </div>
              {question.isOther || !question.options?.length ? (
                <input
                  testId={`draft-${block.id}-${question.id}`}
                  value={block.drafts[question.id] ?? ''}
                  onChange={(event) => session.setApprovalDraft(block.id, question.id, event.value ?? '')}
                  theme={LIGHT}
                  style={{ fontSize: 13, fontFamily: FONT, color: C.text }}
                />
              ) : null}
            </div>
          ))
        : null}
      {block.resolved ? (
        <text style={{ fontSize: 12, fontFamily: FONT, color: C.muted }}>{block.resolved}</text>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
          <div
            testId={`accept-${block.id}`}
            onClick={() => session.resolveApproval(block.id, true)}
            style={{
              height: 28,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 4,
              backgroundColor: C.blue,
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
            }}
          >
            <text style={{ fontSize: 13, fontFamily: FONT, color: C.page }}>Accept</text>
          </div>
          <div
            testId={`skip-${block.id}`}
            onClick={() => session.resolveApproval(block.id, false)}
            style={{
              height: 28,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 4,
              backgroundColor: C.chip,
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
              hover: { backgroundColor: C.chipActive },
            }}
          >
            <text style={{ fontSize: 13, fontFamily: FONT, color: C.text }}>Skip</text>
          </div>
        </div>
      )}
    </div>
  )
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size))
  return rows
}

function formatOpened(unixSeconds: number | null) {
  if (!unixSeconds) return ''
  return `Opened ${new Date(unixSeconds * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })}`
}

function needsReconnect(server: Snapshot['mcpServers'][number]) {
  return (
    server.authStatus === 'notLoggedIn' ||
    server.runtimeStatus === 'authenticationRequired' ||
    server.runtimeStatus === 'failed'
  )
}

function toolsNeedingConnect(servers: Snapshot['mcpServers']) {
  return servers.filter(needsReconnect)
}

function displayServerName(name: string) {
  if (!name) return 'A connected app'
  return name.charAt(0).toUpperCase() + name.slice(1)
}
