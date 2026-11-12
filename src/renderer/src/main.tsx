import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app'
import { loadMarkdown } from './components/ui/loadMarkdown'
import './styles/index.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Home paints without the Markdown renderer; fetch it once the page is idle.
requestIdleCallback(() => void loadMarkdown(), { timeout: 2000 })
