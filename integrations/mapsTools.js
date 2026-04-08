/**
 * Google Maps Tools — Built-in tools for AI to get directions and search places
 * 
 * Uses Google Maps Directions API for routing, Places API for location search,
 * and returns Embed API URLs for rendering interactive maps in chat.
 */

const configStore = require('../stores/configStore');

// ─── Tool Definitions ──────────────────────────────────────────

const MAPS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'maps_directions',
            description: 'Get directions from one location to another. Returns step-by-step directions, total duration, total distance, and an embeddable map URL showing the route. Use this when the user asks how to get from A to B, travel time, or route planning.',
            parameters: {
                type: 'object',
                properties: {
                    origin: {
                        type: 'string',
                        description: 'Starting location (address, city name, or place name)'
                    },
                    destination: {
                        type: 'string',
                        description: 'Destination location (address, city name, or place name)'
                    },
                    mode: {
                        type: 'string',
                        enum: ['driving', 'walking', 'bicycling', 'transit'],
                        description: 'Travel mode (default: driving)'
                    },
                    avoid: {
                        type: 'string',
                        description: 'Comma-separated list of features to avoid: tolls, highways, ferries'
                    }
                },
                required: ['origin', 'destination']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'maps_search_places',
            description: 'Search for places, businesses, or points of interest near a location. Returns names, addresses, ratings, and map links. Use this when the user asks about restaurants, shops, attractions, or any businesses near a location.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query (e.g. "restaurants near Amsterdam", "gas stations in Rotterdam")'
                    },
                    location: {
                        type: 'string',
                        description: 'Optional center location for the search (address or city name). If not provided, the query should include location context.'
                    },
                    radius: {
                        type: 'integer',
                        description: 'Search radius in meters (default 5000, max 50000)'
                    }
                },
                required: ['query']
            }
        }
    }
];

// ─── Helper: Get API Key ───────────────────────────────────────

async function getMapsApiKey() {
    const key = await configStore.getSecret('google_maps_api_key');
    if (!key) throw new Error('Google Maps API key not configured. Set it in Settings → Keys as google_maps_api_key.');
    return key;
}

// ─── Helper: Geocode a location string to lat/lng ──────────────

async function geocode(address, apiKey) {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status !== 'OK' || !data.results?.length) return null;
    return data.results[0].geometry.location; // { lat, lng }
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeMapsTool(toolName, args) {
    const apiKey = await getMapsApiKey();

    if (toolName === 'maps_directions') {
        const { origin, destination } = args;
        if (!origin) return { error: 'origin is required' };
        if (!destination) return { error: 'destination is required' };

        const mode = args.mode || 'driving';
        const avoid = args.avoid || '';

        console.log(`[Maps] Directions: ${origin} → ${destination} (${mode})`);

        // Call Directions API with real-time traffic data
        let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=${mode}&key=${apiKey}`;
        if (avoid) url += `&avoid=${encodeURIComponent(avoid)}`;
        // Request real-time traffic data for driving mode
        if (mode === 'driving') {
            url += `&departure_time=now&traffic_model=best_guess`;
        }

        const res = await fetch(url);
        const data = await res.json();

        if (data.status !== 'OK') {
            return {
                error: `Could not find directions: ${data.status}`,
                detail: data.error_message || 'Check that both origin and destination are valid locations.'
            };
        }

        const route = data.routes[0];
        const leg = route.legs[0];

        // Extract step-by-step directions (strip HTML tags)
        const steps = leg.steps.map((step, i) => ({
            instruction: step.html_instructions.replace(/<[^>]*>/g, ''),
            distance: step.distance.text,
            duration: step.duration.text,
            travelMode: step.travel_mode
        }));

        // Use duration_in_traffic (real-time) when available, else fall back to standard duration
        const realTimeDuration = leg.duration_in_traffic ? leg.duration_in_traffic.text : leg.duration.text;

        // Build embed URL (free, unlimited usage)
        const embedUrl = `https://www.google.com/maps/embed/v1/directions?key=${apiKey}&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=${mode}`;

        // Build Google Maps link for "Open in Maps"
        const mapsLink = `https://www.google.com/maps/dir/${encodeURIComponent(origin)}/${encodeURIComponent(destination)}`;

        return {
            _action: 'map_embed',
            _mapEmbed: { embedUrl, title: 'Route ' + leg.start_address + ' \u2192 ' + leg.end_address, mapsLink },
            origin: leg.start_address,
            destination: leg.end_address,
            mode,
            duration: realTimeDuration,
            duration_without_traffic: leg.duration.text,
            duration_in_traffic: leg.duration_in_traffic ? leg.duration_in_traffic.text : null,
            distance: leg.distance.text,
            steps: steps.slice(0, 15), // Cap at 15 steps to keep response manageable
            totalSteps: steps.length,
            embedUrl,
            mapsLink,
            summary: route.summary,
            warnings: route.warnings || [],
            message: 'Route from ' + leg.start_address + ' to ' + leg.end_address + ': ' + leg.distance.text + ', ' + realTimeDuration + (leg.duration_in_traffic ? ' (with current traffic)' : '') + ' (' + mode + ')'
        };

    } else if (toolName === 'maps_search_places') {
        const { query } = args;
        if (!query) return { error: 'query is required' };

        const radius = Math.min(Math.max(parseInt(args.radius) || 5000, 100), 50000);

        console.log(`[Maps] Places search: "${query}"`);

        // If a specific location is provided, geocode it first
        let locationParam = '';
        if (args.location) {
            const coords = await geocode(args.location, apiKey);
            if (coords) {
                locationParam = `&location=${coords.lat},${coords.lng}&radius=${radius}`;
            }
        }

        // Text Search (New) API
        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}${locationParam}&key=${apiKey}`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
            return {
                error: `Places search failed: ${data.status}`,
                detail: data.error_message || 'Try a different search query.'
            };
        }

        const places = (data.results || []).slice(0, 10).map(place => ({
            name: place.name,
            address: place.formatted_address,
            rating: place.rating || null,
            totalRatings: place.user_ratings_total || 0,
            priceLevel: place.price_level !== undefined ? '💰'.repeat(place.price_level) : null,
            isOpen: place.opening_hours?.open_now ?? null,
            types: (place.types || []).slice(0, 3).join(', '),
            mapsLink: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
            location: place.geometry?.location || null
        }));

        // Build embed URL for the search area
        const embedUrl = `https://www.google.com/maps/embed/v1/search?key=${apiKey}&q=${encodeURIComponent(query)}`;

        return {
            _action: 'map_embed',
            _mapEmbed: { embedUrl, title: 'Search: ' + query, mapsLink: null },
            query,
            results: places,
            count: places.length,
            embedUrl,
            message: places.length > 0
                ? `Found ${places.length} place(s) for "${query}".`
                : `No places found for "${query}".`
        };

    } else {
        throw new Error(`Unknown Maps tool: ${toolName}`);
    }
}

// ─── Tool Check ────────────────────────────────────────────────

function isMapsTool(toolName) {
    return ['maps_directions', 'maps_search_places'].includes(toolName);
}

module.exports = {
    MAPS_TOOLS,
    executeMapsTool,
    isMapsTool,
};
