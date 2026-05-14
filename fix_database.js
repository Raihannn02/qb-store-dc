require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function migrate() {
    console.log('🚀 Starting Database Migration...');

    // Using a trick: try to update a non-existent row to see if the column exists
    // But better: Just try to select it.
    const { error: checkErr } = await supabase.from('products').select('system_type').limit(1);

    if (!checkErr) {
        console.log('✅ Column "system_type" already exists. No migration needed.');
        return;
    }

    console.log('⏳ Column missing. Attempting to add it via logic check...');
    console.log('IMPORTANT: If this fails, please run the following SQL in Supabase SQL Editor:');
    console.log('ALTER TABLE products ADD COLUMN system_type TEXT DEFAULT \'regular\';');

    // Note: supabase-js cannot run ALTER TABLE directly unless a custom RPC is defined.
    // So we primarily guide the user to the SQL Editor but the bot code is now RESILIENT.
}

migrate();
