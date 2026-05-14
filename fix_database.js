require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function migrate() {
    console.log('🚀 Starting Database Migration...');

    // Using a trick: try to update a non-existent row to see if the column exists
    // But better: Just try to select it.
    const { error: checkErr } = await supabase.from('products').select('system_type').limit(1);

    if (!checkErr) {
        console.log('✅ Column "system_type" already exists in products. No migration needed.');
    } else {
        console.log('⏳ Column missing. Attempting to add it via logic check...');
        console.log('IMPORTANT: If this fails, please run the following SQL in Supabase SQL Editor:');
        console.log('ALTER TABLE products ADD COLUMN system_type TEXT DEFAULT \'regular\';');
    }

    console.log('\n🚀 Verifying "auctions" table and "bid_increment" column...');
    const { error: aucErr } = await supabase.from('auctions').select('bid_increment').limit(1);

    if (!aucErr) {
        console.log('✅ "auctions" table and "bid_increment" column are configured and cached.');
    } else {
        console.log('❌ "auctions" table check failed or "bid_increment" missing.');
        console.log('IMPORTANT: To fix schema cache errors when creating an auction, please run the following SQL in Supabase SQL Editor:\n');
        console.log('CREATE TABLE IF NOT EXISTS auctions (');
        console.log('  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,');
        console.log('  name TEXT NOT NULL,');
        console.log('  description TEXT,');
        console.log('  base_price BIGINT NOT NULL,');
        console.log('  current_bid BIGINT NOT NULL,');
        console.log('  bid_increment BIGINT DEFAULT 5000,');
        console.log('  highest_bidder_id TEXT,');
        console.log('  product_id TEXT,');
        console.log('  status TEXT DEFAULT \'pending\',');
        console.log('  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),');
        console.log('  end_time TIMESTAMP WITH TIME ZONE');
        console.log(');');
        console.log('ALTER TABLE auctions ADD COLUMN IF NOT EXISTS bid_increment BIGINT DEFAULT 5000;');
        console.log('\n⚠️ VERY IMPORTANT: After running the query, go to Supabase Settings -> API -> Tables & Views -> and click "Reload Schema Cache"!');
    }

    // Note: supabase-js cannot run ALTER TABLE directly unless a custom RPC is defined.
    // So we primarily guide the user to the SQL Editor.
}

migrate();
