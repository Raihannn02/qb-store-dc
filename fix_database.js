require('dotenv').config();
const supabase = require('./supabaseClient');

async function migrate() {
    console.log('🚀 Starting Database Migration...');

    // Using a trick: try to update a non-existent row to see if the column exists
    const { data: cols, error: colErr } = await supabase.from('products').select('system_type, category_name, description').limit(1);

    if (colErr) {
        console.log('❌ Column check failed for products. Adding missing columns...');
        console.log('ALTER TABLE products ADD COLUMN IF NOT EXISTS system_type TEXT DEFAULT \'regular\';');
        console.log('ALTER TABLE products ADD COLUMN IF NOT EXISTS category_name TEXT;');
        console.log('ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;');
    } else {
        console.log('✅ "products" table schema is up to date.');
    }

    console.log('\n🚀 Verifying "auctions" table: columns and schema cache...');
    const { error: aucErr } = await supabase.from('auctions').select('bid_increment, product_id, category_name').limit(1);

    if (!aucErr) {
        console.log('✅ "auctions" table columns (bid_increment, product_id, category_name) are configured and cached.');
    } else {
        console.log('❌ "auctions" table check failed or columns missing.');
        console.log('IMPORTANT: To fix schema cache errors when creating an auction, please run the following SQL in Supabase SQL Editor:\n');
        console.log('CREATE TABLE IF NOT EXISTS auctions (');
        console.log('  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,');
        console.log('  name TEXT NOT NULL,');
        console.log('  category_name TEXT,');
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
        console.log('ALTER TABLE auctions ADD COLUMN IF NOT EXISTS product_id TEXT;');
        console.log('ALTER TABLE auctions ADD COLUMN IF NOT EXISTS category_name TEXT;');
        console.log('\n-- Create auction_bids table for history');
        console.log('CREATE TABLE IF NOT EXISTS auction_bids (');
        console.log('  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,');
        console.log('  auction_id UUID REFERENCES auctions(id) ON DELETE CASCADE,');
        console.log('  user_id TEXT NOT NULL,');
        console.log('  amount BIGINT NOT NULL,');
        console.log('  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()');
        console.log(');');
        console.log('\n⚠️ VERY IMPORTANT: After running the query, go to Supabase Settings -> API -> Tables & Views -> and click "Reload Schema Cache"!');
    }

    // Note: supabase-js cannot run ALTER TABLE directly unless a custom RPC is defined.
    // So we primarily guide the user to the SQL Editor.
}

migrate();
