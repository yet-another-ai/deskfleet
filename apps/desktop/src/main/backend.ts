/** Vite embeds the backend address when it builds the desktop main process. */
export const backendUrl = import.meta.env.VITE_DESKFLEET_SERVER_URL ?? "http://localhost:8080"
