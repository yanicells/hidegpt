import { useSyncExternalStore } from 'react'

/**
 * The optional profile picture set from the account menu. It lives only in
 * this window's storage, as a small square JPEG data URL; without one, the
 * avatars show the account's letter.
 */
const KEY = 'hidegpt-profile-photo'
/** Twice the largest avatar (80px), for sharp edges on a 2x screen. */
const SIZE = 160

const listeners = new Set<() => void>()

const read = (): string | null => localStorage.getItem(KEY)

function write(next: string | null): void {
  if (next === null) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, next)
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

/** Crops the image's centre square, scales it to 160px and keeps it. Rejects if the file is not an image. */
export async function setProfilePhoto(file: Blob): Promise<void> {
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
