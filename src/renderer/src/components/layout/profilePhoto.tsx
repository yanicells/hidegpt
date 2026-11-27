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

/** Larger pictures are refused before decoding: a small file can still unpack to gigabytes of pixels. */
export const MAX_PHOTO_PIXELS = 50_000_000

/** The picture's size from its header; nothing draws it, so its pixels are never decoded. */
async function imageSize(file: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    const loaded = new Promise<unknown>((resolve, reject) => {
      image.onload = resolve
      image.onerror = reject
    })
    image.src = url
    await loaded
    return { width: image.naturalWidth, height: image.naturalHeight }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Crops the image's centre square, scales it to 160px and keeps it. Rejects a file that is too big or not an image. */
export async function setProfilePhoto(file: Blob): Promise<void> {
  if (file.size > MAX_PHOTO_BYTES) throw new RangeError('Picture too large')
  const { width, height } = await imageSize(file)
  if (width * height > MAX_PHOTO_PIXELS) throw new RangeError('Picture too large')
  const side = Math.min(width, height)
  // Decoded straight to the 160px square, so no full-size bitmap is kept.
  const image = await createImageBitmap(file, (width - side) / 2, (height - side) / 2, side, side, {
    resizeWidth: SIZE,
    resizeHeight: SIZE,
    resizeQuality: 'high',
  })
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  canvas.getContext('2d')?.drawImage(image, 0, 0)
  image.close()
  write(canvas.toDataURL('image/jpeg', 0.9))
}

/** An avatar's face: the profile picture when one is set, else the account's letter. */
export function AvatarFace({ letter, className }: { letter: string; className?: string }) {
  const photo = useProfilePhoto()
  return <span className={className}>{photo ? <img src={photo} alt="" /> : letter}</span>
}
