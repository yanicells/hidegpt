import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './fonts'
import { App } from './app'
import { PageFallback, RenderErrorBoundary, reportRenderError } from './components/layout/RenderErrorBoundary'
import { loadMarkdown } from './components/ui/loadMarkdown'
import { TooltipProvider } from './components/ui/tooltip'
import { addFontMenuFaces } from './fontMenu'
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

// Home paints without the Markdown renderer or the font menu's faces. Add both
// right after the first frame (the timeout runs once that frame is drawn), so a
// document opened in the first moments finds the renderer loading or loaded.
requestAnimationFrame(() =>
  setTimeout(() => {
    void loadMarkdown()
    addFontMenuFaces()
  }),
)
