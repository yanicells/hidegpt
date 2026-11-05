import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './fonts'
import { App } from './app'
import { TooltipProvider } from './components/ui/tooltip'
import './styles/index.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
)
