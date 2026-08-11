import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { WorkspaceRoot } from './WorkspaceRoot.tsx'
import { AuthGate } from './auth/AuthGate.tsx'
import { installTraceSeam, resolveGpuIdentity } from './trace/seam.ts'
import { traceRecorder } from './trace/recorder.ts'

// The trace seam is public interface in every build (ADR 0051): a
// diagnostic that only exists in development cannot explain a field report.
installTraceSeam()
void resolveGpuIdentity().then(gpu => traceRecorder.setGpu(gpu))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <WorkspaceRoot />
    </AuthGate>
  </StrictMode>,
)
