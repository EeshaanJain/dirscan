import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initToken } from '@/lib/api'
import { applyStoredTheme } from '@/ui/ThemeProvider'

initToken() // read ?token= once, keep it for this tab, strip it from the address bar
applyStoredTheme() // before the first paint, so there is no flash of the wrong theme

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
