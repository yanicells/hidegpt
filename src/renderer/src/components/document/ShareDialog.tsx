import { accountLabel, avatarLetter } from '../../../../shared/labels'
import type { Snapshot } from '../../../../shared/model'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '../ui/dialog'
import { MIcon } from '../ui/MaterialIcon'
import { personName } from '../ui/text'

/**
 * Drive's "Share" dialog, behind the Share button. A document here is private
 * by nature, so the people field and access picker are costume; "Copy link"
 * copies the document's id, the handle its provider resumes it by.
 */
export function ShareDialog({
  snap,
  open,
  onOpenChange,
  onCopyLink,
}: {
  snap: Snapshot
  open: boolean
  onOpenChange: (open: boolean) => void
  onCopyLink: () => void
}) {
  const label = accountLabel(snap.account)
  const email = label.includes('@') ? label : null
  const name = personName(label)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="share-dialog" data-testid="share-dialog">
        <div className="share-head">
          <DialogTitle render={<h2 />}>Share “{snap.title || 'Untitled document'}”</DialogTitle>
          <span className="share-head-icons" aria-hidden="true">
            <MIcon name="help" size={24} />
            <MIcon name="settings" size={24} />
          </span>
        </div>
        <label className="outlined-field">
          <input aria-label="Add people, groups, and calendar events" placeholder="Add people, groups, and calendar events" />
        </label>
        <h3 className="share-section">People with access</h3>
        <div className="share-person">
          <span className="avatar-sm share-avatar">{avatarLetter(snap.account)}</span>
          <span className="share-person-text">
            {name} (you)
            {email ? <small>{email}</small> : null}
          </span>
          <span className="share-role">Owner</span>
        </div>
        <h3 className="share-section">General access</h3>
        <div className="share-person">
          <span className="share-access-icon" aria-hidden="true">
            <MIcon name="lock" />
          </span>
          <span className="share-person-text">
            <span className="share-access">
              Restricted
              <MIcon name="arrow_drop_down" />
            </span>
            <small>Only people with access can open with the link</small>
          </span>
        </div>
        <div className="share-foot">
          <button type="button" className="outlined-button" data-testid="share-copy-link" onClick={onCopyLink}>
            <MIcon name="link" />
            Copy link
          </button>
          <DialogClose className="filled-button">Done</DialogClose>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
