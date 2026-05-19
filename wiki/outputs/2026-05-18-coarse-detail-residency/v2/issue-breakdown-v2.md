# Issue breakdown v2: Chunk-only coarse/detail residency

Parent PRD: #672
Spec: `prd-v2.md`

This is the filed v2 implementation breakdown.

1. **Source metadata, detail control, and source coarse selection**
   - Type: AFK
   - Blocked by: none
   - Stories: 1, 2, 8, 12, 22, 23
   - Issue: #681
   - Draft: `slice-01-v2.md`

2. **Clean source-backed tier renderer**
   - Type: AFK
   - Blocked by: #681
   - Stories: 3, 6, 7, 16, 17, 27, 28, 29
   - Issue: #682
   - Draft: `slice-02-v2.md`

3. **Client tier residency, cancellation, and transfer allocations**
   - Type: AFK
   - Blocked by: #682
   - Stories: 13, 14, 15, 16, 17, 26, 30
   - Issue: #683
   - Draft: `slice-03-v2.md`

4. **Generated coarse availability protocol and source-aware resolver**
   - Type: AFK
   - Blocked by: #681
   - Stories: 9, 12, 20, 21, 31, 33
   - Issue: #684
   - Draft: `slice-04-v2.md`

5. **Derived cache and generated coarse materialization**
   - Type: AFK
   - Blocked by: #684
   - Stories: 9, 10, 11, 24, 25, 31, 32
   - Issue: #685
   - Draft: `slice-05-v2.md`

6. **Viewer-interest scheduling and server generation cancellation**
   - Type: AFK
   - Blocked by: #685
   - Stories: 13, 14, 15, 16, 21, 24, 31
   - Issue: #686
   - Draft: `slice-06-v2.md`

7. **Derived-cache recovery, disk budget, and operator controls**
   - Type: AFK
   - Blocked by: #685
   - Stories: 10, 24, 25, 26, 33
   - Issue: #687
   - Draft: `slice-07-v2.md`

8. **Minimap separation, status UI, and telemetry**
   - Type: AFK
   - Blocked by: #682, #683, #684
   - Stories: 4, 5, 18, 19, 26
   - Issue: #688
   - Draft: `slice-08-v2.md`

9. **Default flip and proxy retirement**
   - Type: HITL
   - Blocked by: #682, #683, #684, #685, #686, #687, #688
   - Stories: 6, 27, 34
   - Issue: #689
   - Draft: `slice-09-v2.md`

10. **End-to-end coverage and wiki finalization**
    - Type: AFK
    - Blocked by: #689
    - Stories: 1, 2, 3, 6, 9, 10, 20, 21, 22, 23, 33, 34
    - Issue: #690
    - Draft: `slice-10-v2.md`
