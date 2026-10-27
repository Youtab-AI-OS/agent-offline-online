import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './app.tsx'
import ErrorBoundary, { rootErrorHandlers } from './error-boundary'
import { watchTheme } from './theme'

// Follow the OS light/dark appearance. theme.ts paints the first frame on
// import (synchroyoutably, from the media query); this subscribes to live OS
// theme changes via the authoritative Tauri window theme.
void watchTheme()

createRoot(document.getElementById('root')!, rootErrorHandlers).render(
  <StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </StrictMode>
)
