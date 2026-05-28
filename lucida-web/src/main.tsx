import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { WorkspaceRoot } from './WorkspaceRoot.tsx'
import { AuthGate } from './auth/AuthGate.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <WorkspaceRoot />
    </AuthGate>
  </StrictMode>,
)
