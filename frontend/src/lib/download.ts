import { http } from '@/api/client'

/** Download an authenticated file (the access token is in memory, so a plain link cannot be used). */
export async function downloadFile(url: string, fallbackName: string) {
  const res = await http.get<Blob>(url, { responseType: 'blob', timeout: 300_000 })
  const disposition = String(res.headers['content-disposition'] ?? '')
  const name = /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? fallbackName
  const href = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}
