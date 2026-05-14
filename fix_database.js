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

    if (aucErr) {
        console.log('❌ "auctions" table check failed or columns missing.');
        console.log('IMPORTANT: Run the following SQL in Supabase SQL Editor:');
        console.log('ALTER TABLE auctions ADD COLUMN IF NOT EXISTS bid_increment BIGINT DEFAULT 5000;');
        console.log('ALTER TABLE auctions ADD COLUMN IF NOT EXISTS product_id TEXT;');
        console.log('ALTER TABLE auctions ADD COLUMN IF NOT EXISTS category_name TEXT;');
    } else {
        console.log('✅ "auctions" table columns are configured.');
    }

    console.log('\n🚀 Verifying "auction_bids" table (History Tracking)...');
    const { error: bidErr } = await supabase.from('auction_bids').select('id').limit(1);

    if (bidErr) {
        console.log('❌ "auction_bids" table is missing.');
        console.log('IMPORTANT: Run the following SQL in Supabase SQL Editor:\n');
        console.log('-- Create auction_bids table for history tracking');
        console.log('CREATE TABLE IF NOT EXISTS auction_bids (');
        console.log('  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,');
        console.log('  auction_id UUID REFERENCES auctions(id) ON DELETE CASCADE,');
        console.log('  user_id TEXT NOT NULL,');
        console.log('  amount BIGINT NOT NULL,');
        console.log('  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()');
        console.log(');');
        console.log('\n⚠️ VERY IMPORTANT: After running the query, go to Supabase Settings -> API -> Tables & Views -> and click "Reload Schema Cache"!');
    } else {
        console.log('✅ "auction_bids" table is ready.');
    }

    console.log('\n🚀 Verifying "banned_users" table (Security)...');
    const { error: banErr } = await supabase.from('banned_users').select('id').limit(1);

    if (banErr) {
        console.log('❌ "banned_users" table is missing.');
        console.log('IMPORTANT: Run the following SQL in Supabase SQL Editor:\n');
        console.log('-- Create banned_users table');
        console.log('CREATE TABLE IF NOT EXISTS banned_users (');
        console.log('  id TEXT PRIMARY KEY,');
        console.log('  reason TEXT,');
        console.log('  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()');
        console.log(');');
    } else {
        console.log('✅ "banned_users" table is ready.');
    }

    // Note: supabase-js cannot run ALTER TABLE directly unless a custom RPC is defined.
    // So we primarily guide the user to the SQL Editor.
}

migrate();
