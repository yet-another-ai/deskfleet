export type RelayLocation = {
  name: string
  coordinates: [longitude: number, latitude: number]
}

export const ownedRelays = [
  { city: "tokyo", coordinates: [139.6917, 35.6895] },
  { city: "frankfurt", coordinates: [8.6821, 50.1109] },
  { city: "shanghai", coordinates: [121.4737, 31.2304] },
  { city: "hongkong", coordinates: [114.1694, 22.3193] },
] satisfies { city: string; coordinates: [number, number] }[]

// Representative cities from https://www.cloudflare.com/network/.
// TURN uses the global Anycast network, excluding the China Network:
// https://developers.cloudflare.com/realtime/turn/#regions
// These city-center coordinates illustrate coverage, not physical server sites.
export const anycastRelays: RelayLocation[] = [
  { name: "Los Angeles", coordinates: [-118.2437, 34.0522] },
  { name: "Ashburn", coordinates: [-77.4874, 39.0438] },
  { name: "Toronto", coordinates: [-79.3832, 43.6532] },
  { name: "São Paulo", coordinates: [-46.6333, -23.5505] },
  { name: "London", coordinates: [-0.1276, 51.5072] },
  { name: "Amsterdam", coordinates: [4.9041, 52.3676] },
  { name: "Johannesburg", coordinates: [28.0473, -26.2041] },
  { name: "Nairobi", coordinates: [36.8219, -1.2921] },
  { name: "Dubai", coordinates: [55.2708, 25.2048] },
  { name: "Mumbai", coordinates: [72.8777, 19.0760] },
  { name: "Singapore", coordinates: [103.8198, 1.3521] },
  { name: "Seoul", coordinates: [126.9780, 37.5665] },
  { name: "Sydney", coordinates: [151.2093, -33.8688] },
  { name: "Auckland", coordinates: [174.7633, -36.8485] },
]

/** Each unordered pair is drawn once; arcs are an illustration of connectivity. */
export function relayConnections(locations: RelayLocation[]) {
  return locations.flatMap((from, index) => locations.slice(index + 1).map(to => ({
    coords: [from.coordinates, to.coordinates],
  })))
}
