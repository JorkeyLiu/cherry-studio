// Shared Settings route importer so chat-idle preload and the Settings route
// render share the same route-resource loading state (same function identity).
// Only the JS module is preloaded; mounting/effects still happen on navigation.
export const importSettingsPage = () => import('../pages/settings/SettingsPage')
