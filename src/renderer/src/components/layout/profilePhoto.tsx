import { useSyncExternalStore } from 'react'

/**
 * The optional profile picture set from the account menu. It is kept in the
 * app's localStorage on disk, so it survives restarts, as a small square JPEG
 * data URL; signing out clears it. Without one, the avatars show the
 * account's letter.
 */
const KEY = 'hidegpt-profile-photo'
/** Larger files are refused before decoding, so a huge image can't stall the window. */
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024
/** Twice the largest avatar (80px), for sharp edges on a 2x screen. */
const SIZE = 160

const listeners = new Set<() => void>()
/** Read from storage once; every avatar render after that reads this copy. */
let photo: string | null | undefined

const read = (): string | null => (photo === undefined ? (photo = localStorage.getItem(KEY)) : photo)

function write(next: string | null): void {
  if (next === null) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, next)
  photo = next
  for (const listener of listeners) listener()
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

/** The picture's data URL, or null for the letter avatar. */
export function useProfilePhoto(): string | null {
  return useSyncExternalStore(subscribe, read, read)
}

export function clearProfilePhoto(): void {
  write(null)
}

/** Crops the image's centre square, scales it to 160px and keeps it. Rejects a file that is too big or not an image. */
export async function setProfilePhoto(file: Blob): Promise<void> {
  if (file.size > MAX_PHOTO_BYTES) throw new RangeError('Picture too large')
  const image = await createImageBitmap(file)
  const side = Math.min(image.width, image.height)
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  canvas
    .getContext('2d')
    ?.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, SIZE, SIZE)
  image.close()
  write(canvas.toDataURL('image/jpeg', 0.9))
}

/** An avatar's face: the profile picture when one is set, else the account's letter. */
export function AvatarFace({ letter, className }: { letter: string; className?: string }) {
  const photo = useProfilePhoto()
  return <span className={className}>{photo ? <img src={photo} alt="" /> : letter}</span>
}
