import { config } from '@vue/test-utils'

// Register globally-mounted components as stubs so component tests don't
// produce "[Vue warn]: Failed to resolve component: AppIcon" errors.
// (AppIcon and AvatarImage are registered globally in main.ts but that
// bootstrap never runs in the Vitest jsdom environment.)
config.global.stubs = {
  ...((config.global.stubs as Record<string, unknown>) ?? {}),
  AppIcon:    true,
  AvatarImage: true,
}
