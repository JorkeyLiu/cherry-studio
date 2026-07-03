import type { InstalledSkill, SkillSearchResult } from '@types'
import { useCallback } from 'react'

/**
 * Hook to manage installed skills.
 * Stub implementation — skills subsystem has been removed.
 */
export function useInstalledSkills(_agentId?: string) {
  return {
    skills: [] as InstalledSkill[],
    loading: false,
    error: null as string | null,
    refresh: async () => {},
    toggle: async () => false,
    uninstall: async () => false
  }
}

/**
 * Hook for searching skills across all 3 registries.
 * Stub implementation — skills subsystem has been removed.
 */
export function useSkillSearch() {
  return {
    results: [] as SkillSearchResult[],
    searching: false,
    error: null as string | null,
    search: async () => {},
    clear: () => {}
  }
}

/**
 * Hook for installing a skill from search results.
 * Stub implementation — skills subsystem has been removed.
 */
export function useSkillInstall() {
  const install = useCallback(
    async (_installSource: string): Promise<{ skill: InstalledSkill | null; error?: string }> => {
      return { skill: null, error: 'Skills subsystem removed' }
    },
    []
  )

  const installFromZip = useCallback(async (_zipFilePath: string): Promise<InstalledSkill | null> => {
    return null
  }, [])

  const installFromDirectory = useCallback(async (_directoryPath: string): Promise<InstalledSkill | null> => {
    return null
  }, [])

  const isInstalling = useCallback((_key?: string) => {
    return false
  }, [])

  return { installingKey: null, isInstalling, install, installFromZip, installFromDirectory }
}
