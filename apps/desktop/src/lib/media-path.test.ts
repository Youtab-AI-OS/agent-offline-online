import { expect, it } from 'vitest'

import { filePathFromMediaPath } from './media'

it('decodes Windows file URLs without adding a root slash or losing UNC host', () => {
  expect(filePathFromMediaPath('file:///C:/Users/Tester/My%20Report.pdf')).toBe('C:/Users/Tester/My Report.pdf')
  expect(filePathFromMediaPath('file://server/share/report.pdf')).toBe('\\\\server\\share\\report.pdf')
  expect(filePathFromMediaPath('file:///srv/report.pdf')).toBe('/srv/report.pdf')
})
