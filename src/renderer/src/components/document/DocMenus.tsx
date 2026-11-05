import { Menubar } from '@base-ui/react/menubar'

import { displayServerName, toolsNeedingConnect } from '../../../../codex/labels'
import type { Snapshot } from '../../../../codex/types'
import { dispatch } from '../../session-bridge'
import { Menu, MenuTrigger } from '../ui/menu'
import { MenuPanel, type Item } from '../ui/MenuPanel'
import { openImagePicker, startSmartChip } from './Composer'

const MENU_ORDER = ['file', 'edit', 'view', 'insert', 'format', 'tools', 'gemini', 'extensions', 'help'] as const
type DocMenu = (typeof MENU_ORDER)[number]

/** A Docs menu row with no meaning here: it looks enabled and simply closes. */
const row = (label: string, extra: Partial<Item> = {}): Item => ({
  id: label.toLowerCase().replace(/\W+/g, '-'),
  label,
  ...extra,
})

export function DocMenus({
  snap,
  outputOnly,
  onToggleOutputOnly,
  onNew,
  onRename,
}: {
  snap: Snapshot
  outputOnly: boolean
  onToggleOutputOnly: () => void
  onNew: () => void
  onRename: () => void
  onGrid?: () => void
  onList?: () => void
}) {
  const inDoc = snap.route.kind === 'doc'
  const addOns = toolsNeedingConnect(snap.mcpServers)

  const items: Record<DocMenu, Item[]> = {
    file: [
      row('New', {
        icon: 'article',
        submenu: [
          { id: 'new-document', label: 'Document', icon: 'article', run: onNew },
          row('From template', { icon: 'description', run: () => dispatch({ op: 'goHome' }) }),
        ],
      }),
      { id: 'open', label: 'Open', icon: 'folder_open', shortcut: '⌘O', run: () => dispatch({ op: 'openFolder' }) },
      row('Make a copy', { icon: 'file_copy' }),
      row('Share', { icon: 'person_add', divider: true, submenu: [row('Share with others'), row('Publish to web')] }),
      row('Email', { icon: 'mail', submenu: [row('Email this file'), row('Email collaborators')] }),
      row('Download', {
        icon: 'download',
        submenu: [row('Microsoft Word (.docx)'), row('PDF Document (.pdf)'), row('Plain Text (.txt)')],
      }),
      { id: 'rename', label: 'Rename', icon: 'edit', divider: true, run: onRename, disabled: !inDoc },
      row('Move', { icon: 'drive_file_move' }),
      row('Add shortcut to Drive', { icon: 'add_to_drive' }),
      row('Move to trash', { icon: 'delete' }),
      row('Version history', {
        icon: 'history',
        divider: true,
        submenu: [
          {
            id: 'load-earlier',
            label: 'See version history',
            run: () => dispatch({ op: 'loadOlderTurns' }),
            disabled: !snap.olderTurnsCursor || snap.loadingOlder,
          },
          row('Name current version'),
        ],
      }),
      row('Make available offline', { icon: 'offline_pin' }),
      row('Details', { icon: 'info', divider: true }),
      row('Security limitations', { icon: 'shield' }),
      row('Language', { icon: 'language', submenu: [row('English (US)', { checked: true })] }),
      row('Page setup', { icon: 'description' }),
      { id: 'print', label: 'Print', icon: 'print', shortcut: '⌘P', divider: true, run: () => window.print() },
    ],
    edit: [
      { id: 'undo', label: 'Undo', icon: 'undo', shortcut: '⌘Z', run: () => document.execCommand('undo') },
      { id: 'redo', label: 'Redo', icon: 'redo', shortcut: '⌘Y', run: () => document.execCommand('redo') },
      { id: 'cut', label: 'Cut', icon: 'content_cut', shortcut: '⌘X', divider: true, run: () => document.execCommand('cut') },
      { id: 'copy', label: 'Copy', icon: 'content_copy', shortcut: '⌘C', run: () => document.execCommand('copy') },
      row('Paste', { icon: 'content_paste', shortcut: '⌘V' }),
      row('Paste without formatting', { shortcut: '⌘⇧V' }),
      {
        id: 'select',
        label: 'Select all',
        icon: 'select_all',
        shortcut: '⌘A',
        divider: true,
        run: () => document.execCommand('selectAll'),
      },
      row('Delete'),
      row('Find and replace', { icon: 'find_replace', shortcut: '⌘⇧H', divider: true }),
    ],
    view: [
      row('Mode', { icon: 'edit', submenu: [row('Editing', { checked: true }), row('Suggesting'), row('Viewing')] }),
      row('Show print layout', { checked: true, divider: true }),
      row('Show ruler', { checked: true }),
      row('Show tabs & outlines', { checked: true, shortcut: '⌘⌥A' }),
      row('Show equation toolbar', { checked: false }),
      // Tool activity is the document's non-printing scaffolding.
      { id: 'output-only', label: 'Show non-printing characters', checked: !outputOnly, shortcut: '⌘⇧P', run: onToggleOutputOnly },
      row('Full screen', { divider: true }),
    ],
    insert: [
      row('Image', {
        icon: 'image',
        submenu: [{ id: 'image', label: 'Upload from computer', run: openImagePicker, disabled: !inDoc }],
      }),
      row('Table', { icon: 'table', submenu: [row('Insert table')] }),
      row('Building blocks', { icon: 'smart_button', submenu: [row('Meeting notes'), row('Code block')] }),
      {
        id: 'smart-chips',
        label: 'Smart chips',
        icon: 'add_link',
        shortcut: '@',
        run: startSmartChip,
        disabled: snap.skills.length === 0,
      },
      row('Link', { icon: 'link', shortcut: '⌘K' }),
      row('Drawing', { icon: 'draw', submenu: [row('New'), row('From Drive')] }),
      row('Chart', { icon: 'bar_chart', submenu: [row('Bar'), row('Column'), row('Line'), row('Pie')] }),
      row('Horizontal line', { icon: 'horizontal_rule' }),
      row('Emoji', { icon: 'mood' }),
      row('Special characters', { icon: 'special_character' }),
      row('Equation', { icon: 'functions' }),
      row('Watermark', { icon: 'water_drop', divider: true }),
      row('Headers & footers', { icon: 'page_header', submenu: [row('Header'), row('Footer')] }),
      row('Page numbers', { icon: 'tag', submenu: [row('Page numbers')] }),
      row('Break', { icon: 'insert_page_break', submenu: [row('Page break'), row('Section break')] }),
      row('Bookmark', { icon: 'bookmark', divider: true }),
      row('Table of contents', { icon: 'toc', submenu: [row('Plain text'), row('Blue links')] }),
    ],
    format: [
      row('Text', { icon: 'format_bold', submenu: [row('Bold'), row('Italic'), row('Underline')] }),
      row('Paragraph styles', { icon: 'text_fields', submenu: [row('Normal text'), row('Heading 1')] }),
      row('Align & indent', { icon: 'format_align_left', submenu: [row('Left'), row('Center'), row('Right')] }),
      row('Line & paragraph spacing', { icon: 'format_line_spacing', submenu: [row('Single'), row('1.15'), row('Double')] }),
      row('Columns', { icon: 'view_column', submenu: [row('More options')] }),
      row('Bullets & numbering', { icon: 'format_list_numbered', submenu: [row('List options')] }),
      row('Headers & footers', { divider: true }),
      row('Page numbers'),
      row('Page orientation', { icon: 'crop_rotate' }),
      row('Table', { icon: 'table', divider: true, submenu: [row('Table properties')] }),
      row('Image', { icon: 'image', submenu: [row('Image options')] }),
      row('Borders & lines', { icon: 'border_style', submenu: [row('Borders')] }),
      row('Clear formatting', { icon: 'format_clear', shortcut: '⌘\\', divider: true }),
    ],
    tools: [
      row('Spelling and grammar', { icon: 'spellcheck', submenu: [row('Spelling and grammar check')] }),
      row('Word count', { icon: 'format_list_numbered_rtl', shortcut: '⌘⇧C' }),
      row('Review suggested edits', { icon: 'rate_review', shortcut: '⌘⌥O ⌘⌥U' }),
      row('Compare documents', { icon: 'difference' }),
      row('Citations', { icon: 'format_quote' }),
      row('Linked objects'),
      row('Dictionary', { icon: 'dictionary', shortcut: '⌘⇧Y' }),
      row('Translate document', { icon: 'translate', divider: true }),
      row('Voice typing', { icon: 'mic', shortcut: '⌘⇧S' }),
      row('Notification settings', { icon: 'notifications', divider: true }),
      row('Preferences', { icon: 'settings' }),
      row('Accessibility', { icon: 'accessibility_new' }),
      row('Activity dashboard', { icon: 'monitoring', divider: true }),
    ],
    gemini: [row('Help me create'), row('Summarize this document'), row('Refine')],
    extensions: [
      row('Add-ons', { icon: 'extension', submenu: [row('Get add-ons'), row('Manage add-ons')] }),
      row('Apps Script', { icon: 'code' }),
      // Tools that need sign-in show up as installed add-ons.
      ...addOns.map((server, index) => ({
        id: `mcp-${server.name}`,
        label: displayServerName(server.name),
        divider: index === 0,
        submenu: [
          { id: `connect-${server.name}`, label: 'Connect', run: () => dispatch({ op: 'connectMcp', name: server.name }) },
        ],
      })),
    ],
    help: [
      row('Help', { icon: 'help' }),
      row('Training', { icon: 'school' }),
      row('Updates', { icon: 'notifications' }),
      row('Help Docs improve', { divider: true }),
      row('Report abuse'),
      row('Privacy Policy', { divider: true }),
      row('Terms of Service'),
      row('Function list', { divider: true }),
      row('Keyboard shortcuts', { icon: 'keyboard', shortcut: '⌘/' }),
    ],
  }

  return (
    <Menubar className="doc-menus" aria-label="Document" modal={false}>
      {MENU_ORDER.map((id) => (
        <Menu key={id}>
          <MenuTrigger className="menu-label" data-testid={`menu-${id}`}>
            {id.charAt(0).toUpperCase() + id.slice(1)}
          </MenuTrigger>
          <MenuPanel testId={`panel-${id}`} className={`menu-${id}`} items={items[id]} />
        </Menu>
      ))}
    </Menubar>
  )
}
