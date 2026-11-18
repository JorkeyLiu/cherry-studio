/**
 * Route viewport layout-settlement bridge (`registerLayoutSettler` /
 * `settleLayout`): the provider exposes a stable synchronous command, and the
 * message list registers its keeper's `requestHold` as the only settler.
 *
 * Proves the narrow contract through the REAL provider:
 * - `settleLayout` forwards the reason to the registered settler, and
 * - nothing else moves: no projection notify (version stable), no controller
 *   progress (epoch/generation stable), no snapshot write (storage empty).
 */
import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type RouteViewportCommands,
  RouteViewportProvider,
  useRouteViewport,
  useRouteViewportCommands
} from '../routeViewportContext'

vi.mock('@renderer/services/scrollSnapshotCache', () => ({
  handleScrollSnapshotCleared: vi.fn(),
  handleScrollSnapshotRead: vi.fn(() => true),
  handleScrollSnapshotSaved: vi.fn(),
  isScrollSnapshotInvalidated: vi.fn(() => false)
}))

const dispatchMock = vi.hoisted(() => vi.fn())
vi.mock('@renderer/store', () => ({
  useAppDispatch: () => dispatchMock,
  useAppSelector: () => null
}))

let keyvStore: Map<string, unknown>
const installKeyv = (): void => {
  ;(window as unknown as { keyv: unknown }).keyv = {
    get: (k: string) => keyvStore.get(k),
    set: (k: string, v: unknown) => {
      keyvStore.set(k, v)
    },
    remove: (k: string) => {
      keyvStore.delete(k)
    }
  }
}

beforeEach(() => {
  keyvStore = new Map()
  installKeyv()
  dispatchMock.mockClear()
})

const Probe = ({
  onCommands,
  onVersion
}: {
  onCommands: (commands: RouteViewportCommands) => void
  onVersion: (version: number) => void
}) => {
  const commands = useRouteViewportCommands()
  const version = useRouteViewport().version
  useEffect(() => {
    onCommands(commands)
  }, [commands, onCommands])
  useEffect(() => {
    onVersion(version)
  }, [version, onVersion])
  return null
}

const renderProvider = (
  onCommands: (commands: RouteViewportCommands) => void,
  onVersion: (version: number) => void
) => {
  return render(
    <RouteViewportProvider topicId="t1" initialRoute={null}>
      <Probe onCommands={onCommands} onVersion={onVersion} />
    </RouteViewportProvider>
  )
}

describe('route viewport layout-settlement bridge', () => {
  it('forwards settleLayout to the registered keeper hold and moves nothing else', () => {
    let commands: RouteViewportCommands | null = null
    const versions: number[] = []
    const view = renderProvider(
      (c) => {
        commands = c
      },
      (v) => {
        versions.push(v)
      }
    )
    expect(commands).not.toBeNull()
    const live = commands as unknown as RouteViewportCommands
    const controller = live.controller
    const epochBefore = controller.currentEpoch
    const generationBefore = controller.windowGeneration
    const versionsBefore = versions.length
    const storedBefore = keyvStore.size

    const settler = vi.fn()
    act(() => {
      live.registerLayoutSettler?.(settler)
    })
    act(() => {
      live.settleLayout?.('fold-browse')
    })

    // The holder-registered keeper hold runs with the exact reason.
    expect(settler).toHaveBeenCalledTimes(1)
    expect(settler).toHaveBeenCalledWith('fold-browse')
    // Nothing else moved: no projection notify, no controller progress, no
    // snapshot write — layout compensation only.
    expect(versions.length).toBe(versionsBefore)
    expect(controller.currentEpoch).toBe(epochBefore)
    expect(controller.windowGeneration).toBe(generationBefore)
    expect(keyvStore.size).toBe(storedBefore)
    view.unmount()
  })

  it('is a silent no-op with no registration and after unregistering', () => {
    let commands: RouteViewportCommands | null = null
    const view = renderProvider(
      (c) => {
        commands = c
      },
      () => {}
    )
    const live = commands as unknown as RouteViewportCommands
    const controller = live.controller
    const epochBefore = controller.currentEpoch
    const generationBefore = controller.windowGeneration

    // Standalone surfaces (no message list) settle through this path: it must
    // never throw and never touch controller truth.
    act(() => {
      live.settleLayout?.('fold-browse')
    })
    expect(controller.currentEpoch).toBe(epochBefore)
    expect(controller.windowGeneration).toBe(generationBefore)
    expect(keyvStore.size).toBe(0)

    const settler = vi.fn()
    act(() => {
      live.registerLayoutSettler?.(settler)
    })
    act(() => {
      live.registerLayoutSettler?.(null)
    })
    act(() => {
      live.settleLayout?.('fold-browse')
    })
    expect(settler).not.toHaveBeenCalled()
    expect(keyvStore.size).toBe(0)
    view.unmount()
  })
})
