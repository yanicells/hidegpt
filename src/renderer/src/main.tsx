import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Bundled fonts, loaded the way T3 Code loads Inter: Google Sans Flex with its
// optical-size axis for chrome, Roboto for small labels. No runtime CDN.
import '@fontsource-variable/google-sans-flex/opsz.css'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'

import { App } from './app'
import './styles/index.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
