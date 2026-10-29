/** Desktop returns a confirmed native destination. Browser fallback reports
 * only a requested download; it cannot claim where the browser saved it. */
export async function downloadTextFile(
  name: string,
  content: string,
  mimeType = 'text/plain',
  mode: 'download' | 'save-as' = 'download'
) {
  if (window.youtabDesktop?.exportContent) {
    return window.youtabDesktop.exportContent({ name, data: new TextEncoder().encode(content), mode })
  }

  if (mode === 'save-as') {
    throw new Error('Save as requires the current Youtab Desktop application.')
  }

  const blobUrl = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }))
  const link = document.createElement('a')

  link.href = blobUrl
  link.download = name
  link.rel = 'noopener noreferrer'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000)

  return { status: 'started' as const }
}
