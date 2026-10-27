import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import Failure from './failure'

test('a home binding conflict gives recovery guidance without a futile Retry button', () => {
  const html = renderToStaticMarkup(createElement(Failure, { bootstrap: {
    status: 'failed', protocolVersion: null, stages: {}, stageOrder: [], currentStage: null,
    installRoot: null, error: 'Close Youtab and reopen Setup.', errorCode: 'home-binding-conflict', logs: []
  } }))

  expect(html).toContain('Close Youtab and reopen Setup.')
  expect(html).not.toContain('Retry install')
  expect(html).not.toContain('Open logs')
})
