/*
 * Adapted from T3 Code (apps/web/src/components/ui/dialog.tsx).
 * Copyright (c) 2026 T3 Tools Inc. Licensed under the MIT License; see THIRD_PARTY_NOTICES.md.
 */

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'

import { cn, type Styled } from './cn'

/** Modal dialogs on Base UI: focus trap, Escape and backdrop dismissal, scroll lock. Drive-styled in dialogs.css. */
const Dialog = DialogPrimitive.Root

function DialogPopup({ className, children, ...props }: Styled<DialogPrimitive.Popup.Props>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="dialog-backdrop" data-slot="dialog-backdrop" />
      <DialogPrimitive.Viewport className="dialog-viewport" data-slot="dialog-viewport">
        <DialogPrimitive.Popup className={cn('drive-dialog', className)} data-slot="dialog-popup" {...props}>
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  )
}

function DialogTitle({ className, ...props }: Styled<DialogPrimitive.Title.Props>) {
  return <DialogPrimitive.Title className={className} data-slot="dialog-title" {...props} />
}

function DialogClose({ className, ...props }: Styled<DialogPrimitive.Close.Props>) {
  return <DialogPrimitive.Close className={className} data-slot="dialog-close" {...props} />
}

export { Dialog, DialogClose, DialogPopup, DialogTitle }
