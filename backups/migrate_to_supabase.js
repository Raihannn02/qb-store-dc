require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function migrate() {
    console.log('Starting migration to Supabase...');

    try {
        // Users
        const users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
        const userData = users.map(id => ({ id }));
        const { error: userError } = await supabase.from('users').upsert(userData);
        if (userError) console.error('Error migrating users:', userError.message);
        else console.log('Users migrated successfully.');

        // Products
        const products = JSON.parse(fs.readFileSync('products.json', 'utf8'));
        const { error: prodError } = await supabase.from('products').upsert(products);
        if (prodError) console.error('Error migrating products:', prodError.message);
        else console.log('Products migrated successfully.');

        // Stock
        const stockData = JSON.parse(fs.readFileSync('stock.json', 'utf8'));
        let stockToInsert = [];
        for (const [prodId, items] of Object.entries(stockData)) {
            items.forEach(item => {
                stockToInsert.push({ product_id: prodId, content: item });
            });
        }
        if (stockToInsert.length > 0) {
            const { error: stockError } = await supabase.from('stock').insert(stockToInsert);
            if (stockError) console.error('Error migrating stock:', stockError.message);
            else console.log('Stock migrated successfully.');
        }

        // Pending Payments
        const pending = JSON.parse(fs.readFileSync('pending_payments.json', 'utf8'));
        const pendingToInsert = Object.entries(pending).map(([invId, data]) => ({
            invoice_id: invId,
            user_id: data.userId,
            product_id: data.productId,
            qty: data.qty,
            amount: data.amount,
            created_at: new Date(data.createdAt).toISOString()
        }));
        if (pendingToInsert.length > 0) {
            const { error: pendingError } = await supabase.from('pending_payments').upsert(pendingToInsert);
            if (pendingError) console.error('Error migrating pending payments:', pendingError.message);
            else console.log('Pending payments migrated successfully.');
        }

        console.log('Migration attempt finished.');
    } catch (err) {
        console.error('Migration failed:', err.message);
    }
}

migrate();
