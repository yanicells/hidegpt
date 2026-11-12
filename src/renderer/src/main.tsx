import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './fonts'
import { App } from './app'
import { PageFallback, RenderErrorBoundary, reportRenderError } from './components/layout/RenderErrorBoundary'
import { loadMarkdown } from './components/ui/loadMarkdown'
import { TooltipProvider } from './components/ui/tooltip'
import './styles/index.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root, { onCaughtError: reportRenderError }).render(
  <StrictMode>
    <RenderErrorBoundary fallback={<PageFallback />}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </RenderErrorBoundary>
  </StrictMode>,
)

// Home paints without the Markdown renderer; fetch it once the page is idle.
requestIdleCallback(() => void loadMarkdown(), { timeout: 2000 })
