import express from "express";
import cors from "cors";
import path from "path";
import { Resend } from "resend";
import dotenv from "dotenv";
import axios from "axios";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import xmlrpc from "xmlrpc";

dotenv.config();

const app = express();

// Firebase Configuration from Environment Variables
const firebaseConfig = {
  projectId: process.env.FIREBASE_PROJECT_ID || "shani-74636",
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
};

// Initialize Firebase Admin
if (!admin.apps.length) {
  if (firebaseConfig.clientEmail && firebaseConfig.privateKey) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: firebaseConfig.projectId,
        clientEmail: firebaseConfig.clientEmail,
        privateKey: firebaseConfig.privateKey,
      }),
      projectId: firebaseConfig.projectId,
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: firebaseConfig.projectId,
    });
  }
}

// Odoo Configuration
const odooConfig = {
  url: "https://co.hakkal-est.com",
  db: "test",
  apiKey: "b1624329dc9a6ba356f92d9e76eabab105479791",
  username: "aburiyad",
  password: "test",
};

const getOdooCredential = () => odooConfig.apiKey || odooConfig.password;

const isOdooConfigured = () => {
  const { url, db, username } = odooConfig;
  const credential = getOdooCredential();
  return !!(url && db && username && credential);
};

const callOdoo = (service: string, method: string, ...args: any[]): Promise<any> => {
  return new Promise((resolve, reject) => {
    if (!isOdooConfigured()) return reject(new Error("Odoo not configured"));
    try {
      const baseUrl = odooConfig.url.trim().replace(/\/$/, "");
      const urlString = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
      const url = new URL(urlString);
      const isSecure = url.protocol === "https:";
      const options = { 
        host: url.hostname, 
        port: parseInt(url.port) || (isSecure ? 443 : 80), 
        path: `${url.pathname === "/" ? "" : url.pathname}/xmlrpc/2/${service}`.replace(/\/+/g, "/"),
        rejectUnauthorized: false
      };
      const client = isSecure ? xmlrpc.createSecureClient(options) : xmlrpc.createClient(options);
      client.methodCall(method, args, (err: any, value: any) => err ? reject(err) : resolve(value));
    } catch (e: any) { reject(e); }
  });
};

const authenticateOdoo = async () => {
  console.log(`[Odoo Auth] Attempting auth with URL: ${odooConfig.url}, DB: ${odooConfig.db}, User: ${odooConfig.username}`);
  try {
    const uid = await callOdoo("common", "authenticate", odooConfig.db, odooConfig.username, getOdooCredential(), {});
    console.log(`[Odoo Auth] Success, UID: ${uid}`);
    return uid;
  } catch (err: any) {
    console.error(`[Odoo Auth] Failed: ${err.message}`);
    throw err;
  }
};

// Middlewares
app.use(cors());
app.use(express.json());

// Explicit CORS for Vercel
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// Diagnostic route to check Odoo configuration status
app.get("/api/odoo/config-check", (req, res) => {
  res.json({
    url: odooConfig.url || "MISSING",
    db: odooConfig.db || "MISSING",
    username: odooConfig.username || "MISSING",
    hasApiKey: !!odooConfig.apiKey,
    hasPassword: !!odooConfig.password,
    isConfigured: isOdooConfigured(),
    envKeys: Object.keys(process.env).filter(k => k.includes('ODOO') || k.includes('FIREBASE') || k.includes('VITE')),
    vercel: !!process.env.VERCEL,
    nodeEnv: process.env.NODE_ENV
  });
});

// Diagnostic route to check headers
app.get("/api/debug-headers", (req, res) => {
  res.json({
    headers: req.headers,
    method: req.method,
    url: req.url
  });
});

// --- ROUTES ---

app.post("/api/auth/verify-odoo-customer", async (req, res) => {
  const { phone, email } = req.body;
  console.log(`[Odoo Verify] Request received. Email=${email}, Phone=${phone}`);
  console.log(`[Odoo Verify] Environment Check: URL=${odooConfig.url}, DB=${odooConfig.db}, User=${odooConfig.username}`);
  
  try {
    if (!isOdooConfigured()) {
      console.error("[Odoo Verify] Odoo is NOT configured correctly. Missing one of: URL, DB, Username, or Credential.");
      return res.status(500).json({ 
        success: false, 
        error: "Odoo configuration missing on server",
        details: {
          url: !!odooConfig.url,
          db: !!odooConfig.db,
          user: !!odooConfig.username,
          cred: !!getOdooCredential()
        }
      });
    }

    const uid = await authenticateOdoo();
    if (!uid) {
      console.error("[Odoo Verify] Odoo authentication FAILED for user:", odooConfig.username);
      return res.status(401).json({ success: false, error: "Authentication failed" });
    }
    console.log("[Odoo Verify] Odoo authenticated, UID:", uid);

    // Build a more robust domain using Odoo's prefix notation
    let domain: any[] = [];
    const searchTerms: any[] = [];
    
    if (email) searchTerms.push(["email", "=", email.trim().toLowerCase()]);
    if (phone) {
      const cleanPhone = phone.replace(/\D/g, "");
      if (cleanPhone.length > 0) {
        searchTerms.push(["phone", "ilike", cleanPhone]);
        searchTerms.push(["mobile", "ilike", cleanPhone]);
      }
    }

    if (searchTerms.length === 0) {
      return res.status(400).json({ success: false, error: "Phone or email required" });
    }

    // Combine multiple search terms with OR (|)
    // Odoo prefix notation: for 3 terms, it's ["|", "|", term1, term2, term3]
    if (searchTerms.length > 1) {
      for (let i = 0; i < searchTerms.length - 1; i++) {
        domain.push("|");
      }
    }
    domain = domain.concat(searchTerms);

    console.log("[Odoo Verify] Final Search Domain:", JSON.stringify(domain));

// Define basic fields that are guaranteed to exist in Odoo
    const basicOdooFields = [
      "name", "display_name", "email", "phone", "mobile", "id", 
      "street", "street2", "city", "zip", "state_id", "country_id",
      "parent_id", "user_id", "sale_warn", "sale_warn_msg"
    ];

    // These are custom fields that might not exist in every Odoo installation
    // We combine them into a single list to try and fetch everything at once
    const customOdooFields = [
      "salesperson_id", "x_salesperson_id", "x_salesperson", 
      "sales_person_id", "x_salesperson_name", "x_studio_salesperson", 
      "x_sales_person", "x_user_id", "x_studio_field_9Z6i7",
      "x_studio_sales_representative", "x_representative", "x_sales_rep",
      "sales_representative", "x_sales_representative", "sales_representative_id",
      "x_salesperson_name"
    ];

    // Combine all fields for the initial search to be more efficient
    const allSearchFields = [...new Set([...basicOdooFields, ...customOdooFields])];

    console.log("[Odoo Verify] Searching with all potential fields for:", JSON.stringify({ phone, email }));
    
    let customers;
    try {
      customers = await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "res.partner", "search_read", [domain], { 
        fields: allSearchFields, 
        limit: 1 
      });
    } catch (err: any) {
      console.error("[Odoo Verify] Search failed with combined fields, falling back to basic:", err.message);
      // Fallback to only basic fields if one of the custom fields doesn't exist (Odoo might error on unknown fields)
      try {
        customers = await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "res.partner", "search_read", [domain], { 
          fields: basicOdooFields, 
          limit: 1 
        });
      } catch (innerErr: any) {
        return res.status(500).json({ success: false, error: "Search failed: " + innerErr.message });
      }
    }

    console.log("[Odoo Verify] Odoo Search Result Count:", customers.length);

    if (customers.length > 0) {
      let c = customers[0];
      
      // If we don't have the salesperson yet, try to enrich with more fields specifically
      // (Only if we didn't get them in the first call)
      try {
        const enrichedData = await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "res.partner", "read", [[c.id], customOdooFields]);
        if (enrichedData && enrichedData.length > 0) {
          c = { ...c, ...enrichedData[0] };
          console.log("[Odoo Verify] Successfully enriched with custom fields.");
        }
      } catch (err: any) {
        console.warn("[Odoo Verify] Could not fetch custom fields (probably don't exist):", err.message);
        // We continue with basic fields
      }

      console.log(`[Odoo Verify] Customer Found Raw Data:`, JSON.stringify(c, null, 2));
      
      // Smart logging: Find any field that might be a salesperson
      const potentialSalesFields = Object.keys(c).filter(key => 
        (key.toLowerCase().includes('sales') || key.toLowerCase().includes('user')) && c[key]
      );
      
      console.log(`[Odoo Verify] Customer Found: ${c.name} (${c.id})`);
      console.log(`[Odoo Verify] Potential Sales Fields Found:`, potentialSalesFields.map(f => `${f}: ${JSON.stringify(c[f])}`).join(' | '));
      
      let salesperson_id = null;
      let salesperson_name = null;

      // Logic to get salesperson: try various fields, then try the parent
      const extractSalesperson = (partner: any) => {
        if (!partner) return null;

        // Try all potential fields in order of priority, including newly discovered ones
        const priorityFields = [
          'user_id',
          'salesperson_id',
          'sales_person_id',
          'x_salesperson_id',
          'x_salesperson_name',
          'x_salesperson',
          'x_studio_salesperson',
          'x_sales_person',
          'x_user_id',
          'x_studio_field_9Z6i7',
          'x_studio_sales_representative',
          'x_representative',
          'x_sales_rep',
          'sales_representative',
          'x_sales_representative',
          'sales_representative_id'
        ];

        // First pass: check priority fields
        for (const field of priorityFields) {
          const val = partner[field];
          if (val) {
            if (Array.isArray(val) && val.length >= 2) return { id: val[0], name: val[1] };
            if (typeof val === 'string' && val.trim().length > 0) return { id: null, name: val };
            if (typeof val === 'number') return { id: val, name: "Assigned (ID: " + val + ")" };
          }
        }

        // Last ditch effort: search for any field that might be a salesperson
        for (const key in partner) {
          if (key.toLowerCase().includes('salesperson') || key.toLowerCase().includes('sales_person') || key.toLowerCase().includes('representative')) {
            const val = partner[key];
            if (val) {
              if (Array.isArray(val) && val.length >= 2) return { id: val[0], name: val[1] };
              if (typeof val === 'string' && val.trim().length > 0) return { id: null, name: val };
            }
          }
        }

        // Second pass: check ANY field that contains 'sales' or 'user' or 'rep' and has a value
        for (const field of Object.keys(partner)) {
          const lowerField = field.toLowerCase();
          if ((lowerField.includes('sales') || lowerField.includes('user') || lowerField.includes('rep')) && !priorityFields.includes(field)) {
            const val = partner[field];
            if (val) {
              if (Array.isArray(val) && val.length >= 2) return { id: val[0], name: val[1] };
              if (typeof val === 'string' && val.trim().length > 0) return { id: null, name: val };
            }
          }
        }

        return null;
      };

      // Address formatting
      const formatAddress = (partner: any) => {
        const parts = [];
        if (partner.street && partner.street !== false) parts.push(partner.street);
        if (partner.street2 && partner.street2 !== false) parts.push(partner.street2);
        return parts.length > 0 ? parts.join(', ') : "";
      };

      const formatCity = (partner: any) => {
        const parts = [];
        if (partner.city && partner.city !== false) parts.push(partner.city);
        if (partner.state_id && Array.isArray(partner.state_id) && partner.state_id.length > 0) parts.push(partner.state_id[1]);
        if (partner.zip && partner.zip !== false) parts.push(partner.zip);
        return parts.length > 0 ? parts.join(' ') : "";
      };

      let sp = extractSalesperson(c);
      
      // If we found a salesperson, let's log it clearly
      if (sp) {
        console.log(`[Odoo Verify] Extracted Salesperson: ID=${sp.id}, Name=${sp.name}`);
      } else {
        console.log(`[Odoo Verify] NO Salesperson extracted in first pass.`);
        // LOG ALL KEYS FOR DEBUGGING ON VERCEL
        console.log(`[Odoo Verify] DEBUG ALL PARTNER KEYS:`, Object.keys(c).join(', '));
      }
      
      // FALLBACK: If no salesperson found, try fetching ALL fields from Odoo
      if (!sp) {
        console.log("[Odoo Verify] No salesperson found in standard fields, attempting to fetch ALL fields...");
        try {
          const allFieldData = await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "res.partner", "read", [[c.id], []]);
          if (allFieldData && allFieldData.length > 0) {
            const fullContact = allFieldData[0];
            // Log every field that has a non-false value for debugging
            const fieldsWithValues = Object.keys(fullContact).filter(k => fullContact[k] !== false && fullContact[k] !== null);
            console.log("[Odoo Verify] All Available Fields with values:", fieldsWithValues.join(', '));
            
            sp = extractSalesperson(fullContact);
            if (sp) {
              console.log("[Odoo Verify] Found salesperson after fetching all fields:", sp.name);
              c = { ...c, ...fullContact }; // Update customer object with full data
            }
          }
        } catch (err) {
          console.error("[Odoo Verify] Error fetching all fields:", err);
        }
      }
      
      // If no salesperson on contact (even after fallback), try parent company
      if (!sp && c.parent_id && Array.isArray(c.parent_id)) {
        const parentId = c.parent_id[0];
        console.log("[Odoo Verify] No salesperson on contact, checking parent company ID:", parentId);
        try {
          // Fetch parent with all potential salesperson fields
                const parentData = await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "res.partner", "read", [[parentId], [...basicOdooFields, ...customOdooFields]]);
          if (parentData && parentData.length > 0) {
            sp = extractSalesperson(parentData[0]);
            if (sp) console.log("[Odoo Verify] Found salesperson on parent company:", sp.name);
          }
        } catch (e) {
          console.error("[Odoo Verify] Error fetching parent salesperson:", e);
        }
      }

      if (sp) {
        salesperson_id = sp.id;
        salesperson_name = sp.name;
      }
      
      const responseData = { 
        success: true, 
        customer: { 
          ...c, 
          name: c.display_name || c.name,
          street: (c.street && c.street !== false) ? c.street : (formatAddress(c) || ""),
          city: (c.city && c.city !== false) ? c.city : (formatCity(c) || ""),
          district: (c.street2 && c.street2 !== false) ? c.street2 : "",
          salesperson_id: sp?.id || null, 
          salesperson_name: sp?.name || null
        },
        debug: {
          all_fields: Object.keys(c),
          has_sp: !!sp,
          sp_name: sp?.name,
          raw_data: c // Send raw data for inspection
        }
      };
      
      console.log(`[Odoo Verify] Sending Success Response. Customer: ${responseData.customer.name}, Salesperson: ${responseData.customer.salesperson_name}, Address: ${responseData.customer.street}, City: ${responseData.customer.city}`);
      res.json(responseData);
    } else {
      console.log(`[Odoo Verify] No customer found for email/phone provided.`);
      res.json({ success: false, message: "No customer found in Odoo" });
    }
  } catch (error: any) {
    console.error(`[Odoo Verify] Server Error:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api", (req, res) => {
  res.json({ status: "online", message: "Shani API Server Running" });
});

app.post("/api/ping", (req, res) => {
  res.json({ status: "ok", message: "POST connection successful" });
});

app.get("/api/ping", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.get("/api/odoo/test-connection", async (req, res) => {
  try {
    const uid = await authenticateOdoo();
    res.json({ success: !!uid, uid });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Debug Customer Data Route
app.get("/api/odoo/debug-customer", async (req, res) => {
  const { email, phone } = req.query;
  if (!email && !phone) return res.status(400).json({ error: "Email or phone is required" });
  
  try {
    const uid = await authenticateOdoo();
    if (!uid) return res.status(401).json({ error: "Odoo Auth Failed" });
    
    let domain: any[] = [];
    if (email) domain.push(["email", "=", (email as string).trim()]);
    if (phone) domain.push(["phone", "=", (phone as string).trim()]);
    
    // Fetch customer with ALL fields
    const customers = await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "res.partner", "search_read", [domain], { fields: [] });
    
    if (customers.length > 0) {
      const customer = customers[0];
      // Filter out false values for readability
      const cleanData: any = {};
      Object.keys(customer).forEach(key => {
        if (customer[key] !== false) cleanData[key] = customer[key];
      });
      
      res.json({ 
        success: true, 
        message: "This is raw data from Odoo. Look for your salesperson name in these fields.",
        fields_count: Object.keys(cleanData).length,
        data: cleanData 
      });
    } else {
      res.json({ success: false, message: "No customer found" });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Odoo Product Fetch
app.get("/api/odoo/products", async (req, res) => {
  try {
    const uid = await authenticateOdoo();
    if (!uid) return res.status(401).json({ success: false });
    const products = await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "product.template", "search_read", [[]], { fields: ["id", "name", "list_price", "description_sale", "image_1920"], limit: 30 });
    res.json({ success: true, data: products });
  } catch (error: any) { res.status(500).json({ success: false, error: error.message }); }
});

// Odoo Orders
app.get("/api/odoo/orders", async (req, res) => {
  try {
    const uid = await authenticateOdoo();
    if (!uid) return res.status(401).json({ success: false, message: "Odoo Auth Failed" });
    const orders = await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "sale.order", "search_read", [[]], { fields: ["name", "partner_id", "amount_total", "state", "date_order"], limit: 50, order: "id desc" });
    res.json({ success: true, data: orders });
  } catch (error: any) { 
    console.error("Orders Fetch Error:", error);
    res.status(500).json({ success: false, error: error.message }); 
  }
});

// Order Creation
app.post("/api/odoo/orders", async (req, res) => {
  const { customerEmail, items, customerName, phone, salespersonId, salesRepName } = req.body;
  try {
    const uid = await authenticateOdoo();
    if (!uid) return res.status(401).json({ success: false, message: "Odoo Auth Failed" });

    // 1. Find Partner
    const partners = await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "res.partner", "search_read", [[["email", "=", customerEmail]]], { fields: ["id"], limit: 1 });
    if (partners.length === 0) return res.status(403).json({ success: false, message: "Customer not found in Odoo" });

    const partnerId = partners[0].id;

    // 2. Create Order
    const orderData: any = {
      partner_id: partnerId,
      state: 'draft'
    };

    // Try to assign salesperson by ID first, then by name if ID is not available
    if (salespersonId) {
      orderData.user_id = salespersonId;
      console.log("[Odoo Order] Assigning salesperson ID:", salespersonId);
    } else if (salesRepName) {
      // Try to find the salesperson by name in Odoo
      try {
        const salespersons = await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "res.users", "search_read", [[["name", "ilike", salesRepName]]], { fields: ["id", "name"], limit: 1 });
        if (salespersons && salespersons.length > 0) {
          orderData.user_id = salespersons[0].id;
          console.log("[Odoo Order] Found salesperson by name:", salesRepName, "-> ID:", salespersons[0].id);
        } else {
          console.log("[Odoo Order] Salesperson not found by name:", salesRepName);
        }
      } catch (e) {
        console.error("[Odoo Order] Error searching for salesperson by name:", e);
      }
    }

    const orderId = await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "sale.order", "create", [orderData]);

    // 3. Create Order Lines
    if (items && Array.isArray(items)) {
      for (const item of items) {
        // Try to find the product in Odoo
        const products = await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "product.product", "search", [[["name", "ilike", item.name]]]);
        const productId = products.length > 0 ? products[0] : null;

        if (productId) {
          const price = parseFloat(String(item.discountPrice || item.price).replace(/[^\d.]/g, '')) || 0;
          await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "sale.order.line", "create", [{
            order_id: orderId,
            product_id: productId,
            product_uom_qty: item.quantity || 1,
            price_unit: price,
            name: item.name
          }]);
        }
      }
    }

    // Read the final order name
    const orderInfo = await callOdoo("object", "execute_kw", odooConfig.db, uid, getOdooCredential(), "sale.order", "read", [[orderId], ["name"]]);
    res.json({ success: true, orderId, orderName: orderInfo?.[0]?.name });

  } catch (error: any) { 
    console.error("Order Creation Error:", error);
    res.status(500).json({ success: false, error: error.message }); 
  }
});

// Email Notification
app.post("/api/send-email", async (req, res) => {
  const { customerEmail, customerName, items, total, orderId } = req.body;
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: "Resend key missing" });
  
  try {
    const resend = new Resend(process.env.RESEND_API_KEY.trim());
    const { data, error } = await resend.emails.send({
      from: "onboarding@resend.dev",
      to: [customerEmail],
      subject: `Order Confirmation #${orderId}`,
      html: `<p>Hi ${customerName}, your order has been received. Total: SAR ${total}</p>`
    });
    res.json({ success: !error, data, error });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Handle Local Server vs Vercel
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  
  if (process.env.NODE_ENV !== "production") {
    // Development mode with Vite middleware
    import("vite").then(({ createServer }) => {
      createServer({ 
        server: { middlewareMode: true }, 
        appType: "spa" 
      }).then(vite => {
        app.use(vite.middlewares);
        app.listen(PORT, () => console.log(`Dev Server: http://localhost:${PORT}`));
      });
    });
  } else {
    // Production mode - serve built files from dist
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    app.listen(PORT, () => console.log(`Production Server: http://localhost:${PORT}`));
  }
}

export default app;
