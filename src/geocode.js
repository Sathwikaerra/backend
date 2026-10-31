import { config } from './config.js'

/*
 * Reverse geocoding: GPS coordinates -> a street address for the signer's location.
 *   GEOCODER=nominatim (default)  OpenStreetMap's free service: at most 1 request a second, needs no key
 *   GEOCODER=google               Google Geocoding API with GOOGLE_MAPS_API_KEY (better addresses in India)
 *   GEOCODER=off                  coordinates only
 * A failed or slow lookup never blocks signing: the address is then simply left empty.
 */
const TIMEOUT_MS = 6000
const cache = new Map()
const CACHE_SIZE = 500
let lastNominatim = 0

const key = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`

async function nominatim(lat, lng) {
  // Their usage policy: identify the app and stay under one request per second
  const wait = lastNominatim + 1100 - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastNominatim = Date.now()
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'eSign-Doc-Builder/1.0 (signer location address)', 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Nominatim answered ${res.status}`)
  return (await res.json()).display_name || null
}

async function google(lat, lng) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${encodeURIComponent(config.geocode.googleApiKey)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const data = await res.json()
  if (data.status !== 'OK') throw new Error(`Google geocoding: ${data.status}`)
  return data.results?.[0]?.formatted_address || null
}

// Returns the address for these coordinates, or null when it cannot be found
export async function reverseGeocode(lat, lng) {
  const provider = config.geocode.provider
  if (provider === 'off' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const k = key(lat, lng)
  if (cache.has(k)) return cache.get(k)
  try {
    const address = (provider === 'google' && config.geocode.googleApiKey ? await google(lat, lng) : await nominatim(lat, lng))?.slice(0, 500) ?? null
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value)
    cache.set(k, address)
    return address
  } catch (err) {
    console.warn('[geocode] no address for', k, '-', err.message)
    return null
  }
}
