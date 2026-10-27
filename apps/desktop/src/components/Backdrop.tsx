import { useStore } from '@nanostores/react'

import { $backdrop, $backdropOpacity } from '@/store/backdrop'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

export function Backdrop() {
  const on = useStore($backdrop)
  const opacity = useStore($backdropOpacity)

  if (!on) {
    return null
  }

  return (
    <div
      aria-hidden
      className="youtab-backdrop pointer-events-none absolute inset-0 z-2"
      style={{ opacity: opacity / 100 }}
    >
      <img
        alt=""
        className="h-full w-full object-cover object-center"
        fetchPriority="low"
        src={assetPath('ds-assets/youtab-bull-bg.jpg')}
      />
    </div>
  )
}
