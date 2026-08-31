import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { CodexSession, accountLabel, type Snapshot } from '../codex/session'
import type { Block } from '../codex/blocks'
import { C, FONT, LIGHT, PAGE_WIDTH, TITLEBAR } from './theme'

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
      <Toolbar snap={snap} session={session} menu={menu} toggle={toggle} onClose={closeMenu} />
      {snap.showFolder ? <FolderBar session={session} snap={snap} /> : null}
      {snap.error && snap.status === 'ready' ? (
        <text
          testId="error-banner"
          style={{
            fontSize: 12,
            fontFamily: FONT,
            color: C.danger,
            paddingLeft: 12,
            paddingTop: 6,
            paddingBottom: 6,
            flexShrink: 0,
          }}
        >
          {snap.error}
        </text>
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
          height: 28,
          paddingLeft: 78,
          paddingRight: 12,
        }}
      >
      <text style={{ fontSize: 13, fontFamily: FONT, color: C.blue, paddingRight: 16 }}>Docs</text>
      <MenuLabel id="file" label="File" menu={menu} toggle={toggle} />
      <MenuLabel id="edit" label="Edit" menu={menu} toggle={toggle} />
      <MenuLabel id="view" label="View" menu={menu} toggle={toggle} />
      <MenuLabel id="tools" label="Tools" menu={menu} toggle={toggle} />
      <div style={{ flexGrow: 1 }} />
      <MenuLabel id="account" label={accountLabel(snap.account)} menu={menu} toggle={toggle} />
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
          ? [{ id: 'refresh', label: 'Refresh from Codex', run: () => void session.start().then(() => session.refreshCatalog()) }]
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
        <Chip
          testId="chip-effort"
          label={snap.effort ?? 'Effort'}
          open={menu === 'effort'}
          onClick={() => toggle('effort')}
        />
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
    const byProject = new Map<string, typeof snap.threads>()
    const loose: typeof snap.threads = []
    for (const thread of snap.threads) {
      if (thread.projectId) {
        const list = byProject.get(thread.projectId) ?? []
        list.push(thread)
        byProject.set(thread.projectId, list)
      } else {
        loose.push(thread)
      }
    }
    return { byProject, loose }
  }, [snap.threads])

  return (
    <virtual-list
      estimatedItemHeight={48}
      style={{ flexGrow: 1, minHeight: 0, paddingLeft: 48, paddingRight: 48, paddingTop: 24 }}
    >
      <div key="new" style={{ paddingBottom: 24 }}>
        <text testId="docs-home" style={{ fontSize: 14, fontFamily: FONT, color: C.secondary, paddingBottom: 12 }}>
          Start a new document
        </text>
        <div
          testId="new-doc"
          onClick={() => void session.newDocument()}
          style={{
            width: 140,
            height: 180,
            borderRadius: 2,
            borderWidth: 1,
            borderColor: C.line,
            backgroundColor: C.page,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            hover: { borderColor: C.blue },
          }}
        >
          <text style={{ fontSize: 36, fontFamily: FONT, color: C.blue }}>+</text>
        </div>
      </div>
      {snap.projects.map((project) => (
        <div key={`p-${project.id}`} style={{ paddingBottom: 16 }}>
          <text style={{ fontSize: 14, fontFamily: FONT, color: C.secondary, paddingBottom: 8 }}>
            {project.name}
          </text>
          {(grouped.byProject.get(project.id) ?? []).map((thread) => (
            <ThreadRow key={thread.id} thread={thread} onOpen={() => void session.openThread(thread.id)} />
          ))}
        </div>
      ))}
      <div key="recent" style={{ paddingBottom: 16 }}>
        <text style={{ fontSize: 14, fontFamily: FONT, color: C.secondary, paddingBottom: 8 }}>
          Recent
        </text>
        {grouped.loose.length === 0 && snap.threads.length === 0 ? (
          <text style={{ fontSize: 13, fontFamily: FONT, color: C.muted }}>No documents yet</text>
        ) : grouped.loose.length === 0 ? (
          <text style={{ fontSize: 13, fontFamily: FONT, color: C.muted }}>All documents are in folders</text>
        ) : (
          grouped.loose.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} onOpen={() => void session.openThread(thread.id)} />
          ))
        )}
      </div>
    </virtual-list>
  )
}

function ThreadRow({
  thread,
  onOpen,
}: {
  thread: Snapshot['threads'][number]
  onOpen: () => void
}) {
  const title = thread.name?.trim() || thread.preview?.trim() || 'Untitled document'
  return (
    <div
      testId={`thread-${thread.id}`}
      onClick={onOpen}
      style={{
        height: 44,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 4,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        cursor: 'pointer',
        hover: { backgroundColor: C.chip },
      }}
    >
      <text style={{ flexGrow: 1, fontSize: 14, fontFamily: FONT, color: C.text }}>{title}</text>
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
        estimatedItemHeight={48}
        followTail={snap.streaming}
        style={{
          width: PAGE_WIDTH,
          flexGrow: 1,
          minHeight: 0,
          backgroundColor: C.page,
          paddingLeft: 72,
          paddingRight: 72,
          paddingTop: 48,
          paddingBottom: 8,
        }}
      >
        <div key="title" style={{ paddingBottom: 28 }}>
          <text style={{ fontSize: 28, fontFamily: FONT, color: C.text }}>{snap.title}</text>
        </div>
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
