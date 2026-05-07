const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// Explicitly define global WebSocket for Node.js < 22 compatibility
if (typeof global.WebSocket === 'undefined') {
    global.WebSocket = WebSocket;
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: {
        persistSession: false
    },
    realtime: {
        websocket: WebSocket
    }
});

module.exports = supabase;
