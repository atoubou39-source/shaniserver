import express from "express";
import { Resend } from "resend";
import dotenv from "dotenv";
import axios from "axios";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import firebaseConfig from "./firebase-applet-config.json" with { type: "json" };
import xmlrpc from "xmlrpc";

dotenv.config();

// Odoo Configuration
const odooConfig = {
  url: process.env.ODOO_URL || "",
  db: process.env.ODOO_DB || "",
  apiKey: process.env.ODOO_API_KEY || "",
  username: process.env.ODOO_USERNAME || "",
  password: process.env.ODOO_PASSWORD || "",
};

// Helper function for Odoo authentication with API key
const authenticateOdoo = async () => {
  if (odooConfig.apiKey) {
    // Use API key authentication (newer Odoo versions)
    return await callOdoo("common", "authenticate", odooConfig.db, odooConfig.username, odooConfig.password, {});
  } else {
    // Use username/password authentication (fallback)
    return await callOdoo("common", "authenticate", odooConfig.db, odooConfig.username, odooConfig.password, {});
  }
};

// Helper function to call Odoo XML-RPC
const callOdoo = (service: string, method: string, ...args: any[]): Promise<any> => {
  return new Promise((resolve, reject) => {
    if (!odooConfig.url) return reject(new Error("Odoo URL is not configured"));
    
    try {
      const baseUrl = odooConfig.url.trim().replace(/\/$/, "");
      const urlString = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
      const url = new URL(urlString);
      
      const isSecure = url.protocol === "https:";
      const baseDir = url.pathname === "/" ? "" : url.pathname;
      const clientPath = `${baseDir}/xmlrpc/2/${service}`.replace(/\/+/g, "/");
      console.log(`[Odoo Debug] Calling: ${urlString}${clientPath} (Service: ${service}, Method: ${method})`);

      const options = { 
        host: url.hostname, 
        port: parseInt(url.port) || (isSecure ? 443 : 80), 
        path: clientPath,
        rejectUnauthorized: false, // Useful for self-signed certificates common in Odoo dev/on-prem
        headers: {
          'User-Agent': 'NodeJS/Odoo-XMLRPC-Client'
        }
      };

      const client = isSecure ? xmlrpc.createSecureClient(options) : xmlrpc.createClient(options);

      client.methodCall(method, args, (err: any, value: any) => {
        if (err) {
          let errorMsg = err.message || String(err);
          
          // Provide specialized hint for common parsing errors
          if (errorMsg.includes("Invalid XML-RPC message") || errorMsg.includes("not a valid XML")) {
            console.error(`Odoo Error (${service}.${method}): Received non-XML response from ${urlString}${clientPath}`);
            errorMsg = "Odoo returned an invalid response. This often happens if the URL is wrong, redirects to a login page, or the server is showing an error page. Verify your ODOO_URL and check if it uses the correct protocol (http vs https).";
          } else {
            console.error(`Odoo XML-RPC Error (${service}.${method}):`, err);
          }
          
          reject(new Error(errorMsg));
        }
        else resolve(value);
      });
    } catch (e: any) {
      reject(new Error(`Odoo Configuration Error: ${e.message}`));
    }
  });
};

// Helper to format date for Odoo (YYYY-MM-DD HH:MM:SS)
const formatOdooDate = (date: Date) => {
  const pad = (num: number) => num.toString().padStart(2, '0');
  const YYYY = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const DD = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}`;
};

// Initialize Firebase Admin
if (!admin.apps.length) {
  console.log("Initializing Firebase Admin with Project ID:", firebaseConfig.projectId);
  
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Cloud deployment: parse service account JSON from env var
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    credential = admin.credential.cert(serviceAccount);
  } else {
    // Local development: use application default credentials
    credential = admin.credential.applicationDefault();
  }
  
  admin.initializeApp({
    credential,
    projectId: firebaseConfig.projectId,
  });
}

const resend = new Resend((process.env.RESEND_API_KEY || "re_dummy_key").trim());

// Temporary store for OTPs (In production, use Firestore or Redis)
const otpStore = new Map<string, { code: string; expires: number }>();

// Helper to verify customer in Odoo
async function verifyOdooCustomer(phone: string): Promise<any> {
  const normalizedPhone = phone.replace(/\D/g, ""); // Normalize: (870)-931-0505 -> 8709310505
  
  if (!odooConfig.url || !odooConfig.db || !odooConfig.username || !odooConfig.password) {
    // Demo mode
    if (normalizedPhone.startsWith("966")) {
      return { id: 999, name: "Odoo Demo Customer", email: `${normalizedPhone}@odoo.demo`, phone: phone };
    }
    // Added Azure Interior test customer
    if (normalizedPhone === "8709310505") {
      return { 
        id: 1001, 
        name: "Azure Interior", 
        email: "azure.Interior24@example.com", 
        phone: "(870)-931-0505" 
      };
    }
    return null;
  }

  try {
    const uid = await authenticateOdoo();
    if (!uid) return null;

    // Search by both phone and mobile fields
    const customers = await callOdoo(
      "object",
      "execute_kw",
      odooConfig.db,
      uid,
      odooConfig.password,
      "res.partner",
      "search_read",
      [[
        "|", ["phone", "=", phone], ["mobile", "=", phone],
        ["customer_rank", ">", 0]
      ]],
      { fields: ["name", "email", "phone", "mobile", "id"], limit: 1 }
    );

    return customers.length > 0 ? customers[0] : null;
  } catch (err) {
    console.error("Odoo Verify Error:", err);
    return null;
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json());
  app.use((req, res, next) => {
    const frontendOrigin = process.env.FRONTEND_ORIGIN?.trim();
    res.header("Access-Control-Allow-Origin", frontendOrigin || "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-odoo-secret");

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
    next();
  });

  // Healthcheck (used by frontend to verify API base URL)
  app.get("/api/ping", (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // API Route for sending OTP via Madar SMS
  app.post("/api/send-otp", async (req, res) => {
    const { phone } = req.body;
    
    if (!phone) {
      return res.status(400).json({ error: "رقم الجوال مطلوب" });
    }

    // MANDATORY: Check if user is registered in Odoo
    try {
      const normalizedPhone = phone.replace(/\D/g, "");
      
      // Bypass check ONLY for specific demo numbers if needed, 
      // but the user wants STRICT Odoo check.
      const isDemoNumber = normalizedPhone === "966500000000" || normalizedPhone === "8709310505";
      
      if (!isDemoNumber) {
        console.log(`[Strict Check] Verifying Odoo for phone: ${phone}`);
        const odooCustomer = await verifyOdooCustomer(phone);
        
        if (!odooCustomer) {
          console.warn(`[Blocked] Registration attempt for non-Odoo number: ${phone}`);
          return res.status(403).json({ 
            error: "عذراً، هذا الرقم غير مسجل في نظام اودو. التسجيل متاح فقط لعملاء المتجر الحاليين. يرجى التواصل مع الإدارة للتسجيل." 
          });
        }
        console.log(`[Success] Customer found in Odoo: ${odooCustomer.name}`);
      } else {
        console.log("Demo number detected, bypassing Odoo check.");
      }
    } catch (error) {
      console.error("Error checking Odoo registration:", error);
      return res.status(500).json({ error: "حدث خطأ أثناء التحقق من الرقم في نظام اودو" });
    }

    const username = process.env.MADAR_SMS_USERNAME;
    const password = process.env.MADAR_SMS_PASSWORD;
    const sender = process.env.MADAR_SMS_SENDER;

    if (!username || !password || !sender) {
      console.warn("Madar SMS configuration missing. Entering Test Mode.");
    }

    // Generate 6-digit OTP
    const normalizedPhone = phone.replace(/\D/g, "");
    const isDemo = normalizedPhone === "966500000000" || normalizedPhone === "8709310505";
    const otp = isDemo ? "123456" : Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 10 * 60 * 1000; // 10 minutes
    otpStore.set(phone, { code: otp, expires });

    console.log(`[OTP DEBUG] Phone: ${phone}, Code: ${otp}`);

    const message = `Your verification code is: ${otp}`;
    
    // If credentials are missing, we'll run in "Test Mode"
    if (!username || !password || !sender) {
      return res.status(200).json({ 
        success: true, 
        message: isDemo ? "OTP generated (Demo Mode). Use 123456." : `OTP generated (Test Mode). Code logged to server console: ${otp}`,
        isTestMode: true,
        testCode: isDemo ? "123456" : otp // In dev/test mode we can return it to UI if we want, or just log it
      });
    }
    
    try {
      // Madar SMS API Call (Standard REST API pattern)
      const response = await axios.get("https://www.madar-sms.com/api/sendsms.php", {
        params: {
          username,
          password,
          numbers: phone,
          sender,
          message: encodeURI(message),
          unicode: 'e', // Arabic support
          return: 'json'
        }
      });

      console.log("Madar SMS Response:", response.data);
      res.status(200).json({ success: true, message: "OTP sent successfully" });
    } catch (error) {
      console.error("Error sending SMS:", error);
      res.status(500).json({ error: "Failed to send OTP" });
    }
  });

  // API Route for verifying OTP and creating custom token
  app.post("/api/verify-otp", async (req, res) => {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: "Phone and OTP are required" });
    }

    const storedData = otpStore.get(phone);

    if (!storedData) {
      return res.status(400).json({ error: "No OTP found for this number" });
    }

    if (Date.now() > storedData.expires) {
      otpStore.delete(phone);
      return res.status(400).json({ error: "OTP expired" });
    }

    if (storedData.code !== otp) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    // OTP is valid, clear it
    otpStore.delete(phone);

    try {
      const authManager = getAuth(admin.app());
      const db = getFirestore(admin.app());

      // Create or get user in Firebase Auth
      let userRecord;
      const e164Phone = phone.startsWith('+') ? phone : `+${phone}`;
      const dummyEmail = `${phone.replace('+', '')}@customer.com`;
      
      try {
        userRecord = await authManager.getUserByPhoneNumber(e164Phone);
        // Ensure user has the dummy email set if it's missing
        if (!userRecord.email) {
          await authManager.updateUser(userRecord.uid, {
            email: dummyEmail,
            emailVerified: true
          });
        }
      } catch (error: any) {
        // Check if Identity Toolkit API is disabled
        if (error.code === 'auth/internal-error' && error.message.includes('identitytoolkit.googleapis.com')) {
          console.warn("CRITICAL: Identity Toolkit API is disabled. Falling back to MOCK AUTH MODE.");
          
          const normalizedPhone = phone.replace(/\D/g, "");
          const mockUid = `mock_user_${normalizedPhone}`;
          
          // Ensure they exist in Firestore even in Mock Mode
          const userDoc = await db.collection("users").doc(mockUid).get();
          if (!userDoc.exists) {
            const odooCustomer = await verifyOdooCustomer(phone);
            await db.collection("users").doc(mockUid).set({
              facilityName: odooCustomer?.name || 'Customer',
              phoneNumber: phone,
              role: 'customer',
              email: dummyEmail,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              odooPartnerId: odooCustomer?.id || null
            });
            console.log(`Created mock user record in Firestore for ${phone}`);
          }
          
          return res.status(200).json({ 
            success: true, 
            uid: mockUid,
            isMockAuth: true,
            warning: "Running in MOCK AUTH MODE because Firebase Identity Toolkit API is disabled. Please enable it in Google Cloud Console."
          });
        }

        if (error.code === 'auth/user-not-found') {
          // If not in Auth, but we got here, it means OTP was verified.
          // We need to ensure they exist in Odoo (we already checked in send-otp, but let's be safe)
          const odooCustomer = await verifyOdooCustomer(phone);
          
          userRecord = await authManager.createUser({
            phoneNumber: e164Phone,
            email: dummyEmail,
            emailVerified: true,
            displayName: odooCustomer?.name || 'Customer'
          });

          // Create Firestore record
          await db.collection("users").doc(userRecord.uid).set({
            facilityName: odooCustomer?.name || 'New Customer',
            phoneNumber: phone,
            role: 'customer',
            email: dummyEmail,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            odooPartnerId: odooCustomer?.id || null
          });
        } else {
          throw error;
        }
      }

      // Check if user has a password set in Firestore or Auth
      // For simplicity, we'll return a flag if they need to set/reset password
      res.status(200).json({ 
        success: true, 
        needsPasswordSet: true, // In this flow, after OTP we always allow setting/resetting password
        uid: userRecord.uid 
      });
    } catch (error) {
      console.error("Error verifying OTP:", error);
      res.status(500).json({ error: "Authentication failed" });
    }
  });

  // API Route for setting password
  app.post("/api/set-password", async (req, res) => {
    const { uid, password } = req.body;

    if (!uid || !password) {
      return res.status(400).json({ error: "UID and password are required" });
    }

    try {
      const authManager = getAuth(admin.app());
      
      // Handle Mock Auth Mode
      if (uid.startsWith('mock_user_')) {
        console.warn("MOCK AUTH: Bypassing Firebase Auth for password update/token creation.");
        return res.status(200).json({ 
          success: true, 
          customToken: "mock_token_" + uid,
          isMockAuth: true 
        });
      }

      // Update Firebase Auth password
      await authManager.updateUser(uid, {
        password: password
      });

      // Create custom token
      const customToken = await authManager.createCustomToken(uid);
      
      res.status(200).json({ success: true, customToken });
    } catch (error) {
      console.error("Error setting password:", error);
      res.status(500).json({ error: "Failed to set password" });
    }
  });

  // API Route for sending emails
  app.post("/api/send-email", async (req, res) => {
    const { orderId, type, customerEmail, customerName, total, items, status } = req.body;
    console.log(`Attempting to send ${type} email to ${customerEmail} via Resend`);

    if (!process.env.RESEND_API_KEY) {
      console.error("RESEND_API_KEY is missing from environment variables.");
      return res.status(500).json({ error: "Email service configuration missing" });
    }

    try {
      console.log("Email Request Body:", JSON.stringify(req.body, null, 2));
      
      if (!orderId || !customerEmail || !type) {
        console.error("Missing required fields for email:", { orderId, customerEmail, type });
        return res.status(400).json({ error: "Missing required fields (orderId, customerEmail, type)" });
      }

      let subject = "";
      let html = "";

      const safeOrderId = orderId ? orderId.slice(0, 8).toUpperCase() : "UNKNOWN";

      if (type === "order_confirmation") {
        subject = `Order Confirmation #${safeOrderId} - Shani's Flavor Lab`;
        html = `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #0f172a; border-bottom: 2px solid #f97316; padding-bottom: 10px;">Order Confirmation</h2>
            <p>Hi ${customerName || 'Customer'},</p>
            <p>Thank you for your order! We've received your request and are processing it now.</p>
            <div style="background: #f8fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0; font-size: 14px; color: #64748b; text-transform: uppercase;">Order Summary</h3>
              ${items && Array.isArray(items) ? items.map((item: any) => `
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                  <span>${item.name} x ${item.quantity}</span>
                  <span style="font-weight: bold;">${item.price}</span>
                </div>
              `).join('') : '<p>No items found</p>'}
              <div style="border-top: 1px solid #e2e8f0; margin-top: 10px; padding-top: 10px; display: flex; justify-content: space-between; font-weight: bold; color: #f97316;">
                <span>Total Amount</span>
                <span>SAR ${total ? total.toLocaleString() : '0'}</span>
              </div>
            </div>
            <p>We will contact you soon for delivery details.</p>
            <p style="font-size: 12px; color: #94a3b8; margin-top: 30px;">
              Hakkal Establishment, Riyadh, Saudi Arabia.
            </p>
          </div>
        `;
      } else if (type === "status_update") {
        const statusLabels: any = {
          pending_payment: 'Pending Payment',
          processing: 'Processing',
          shipped: 'Shipped',
          completed: 'Completed',
          cancelled: 'Cancelled',
          refunded: 'Refunded'
        };
        
        subject = `Order Status Update #${safeOrderId} - Shani's Flavor Lab`;
        html = `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #0f172a; border-bottom: 2px solid #f97316; padding-bottom: 10px;">Order Update</h2>
            <p>Hi ${customerName || 'Customer'},</p>
            <p>The status of your order <strong>#${safeOrderId}</strong> has been updated to:</p>
            <div style="display: inline-block; background: #f97316; color: white; padding: 10px 20px; border-radius: 50px; font-weight: bold; margin: 10px 0;">
              ${statusLabels[status] || status}
            </div>
            <p>Thank you for shopping with Shani's Flavor Lab!</p>
            <p style="font-size: 12px; color: #94a3b8; margin-top: 30px;">
              Hakkal Establishment, Riyadh, Saudi Arabia.
            </p>
          </div>
        `;
      }

      const { data, error } = await resend.emails.send({
        from: "onboarding@resend.dev",
        to: [customerEmail.trim()],
        subject: subject,
        html: html,
      });

      if (error) {
        console.error("Resend API Error Details:", JSON.stringify(error, null, 2));
        return res.status(400).json({ error });
      }

      console.log("Email sent successfully via Resend:", data);
      res.status(200).json({ data });
    } catch (error) {
      console.error("Server Error sending email via Resend:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Internal Server Error" });
    }
  });

  // API Route for seeding demo customer
  app.post("/api/seed-demo", async (req, res) => {
    console.log("POST /api/seed-demo hit");
    const phone = "966500000000";
    const e164Phone = `+${phone}`;
    const dummyEmail = `${phone}@customer.com`;
    const password = "password123";

    try {
      const db = getFirestore(admin.app());
      
      // 2. Create/Update in Firebase Auth
      let userRecord;
      try {
        userRecord = await admin.auth().getUserByPhoneNumber(e164Phone);
        await admin.auth().updateUser(userRecord.uid, {
          email: dummyEmail,
          password: password,
          emailVerified: true
        });
      } catch (error: any) {
        if (error.code === 'auth/user-not-found') {
          userRecord = await admin.auth().createUser({
            phoneNumber: e164Phone,
            email: dummyEmail,
            password: password,
            emailVerified: true
          });
        } else {
          throw error;
        }
      }

      // 1. Create/Update in Firestore (Using Auth UID as Doc ID)
      const usersRef = db.collection("users");
      const userData = {
        facilityName: "Demo Restaurant",
        phoneNumber: phone,
        address: "Riyadh, Saudi Arabia",
        email: dummyEmail,
        role: 'customer',
        updatedAt: new Date().toISOString()
      };

      await usersRef.doc(userRecord.uid).set({
        ...userData,
        createdAt: new Date().toISOString()
      }, { merge: true });

      // 3. Create some dummy orders for this customer
      const ordersRef = db.collection("orders");
      const existingOrders = await ordersRef.where("email", "==", dummyEmail).get();
      
      if (existingOrders.empty) {
        const dummyOrders = [
          {
            customerName: "Demo Restaurant",
            email: dummyEmail,
            phone1: phone,
            address: "Riyadh, Saudi Arabia",
            city: "Riyadh",
            district: "Olaya",
            paymentMethod: "cod",
            items: [
              { id: 1, name: "Saffron Super Negin 5g", price: "SAR 12,500", quantity: 2 }
            ],
            total: 25000,
            status: "completed",
            createdAt: new Date(Date.now() - 86400000 * 2).toISOString() // 2 days ago
          },
          {
            customerName: "Demo Restaurant",
            email: dummyEmail,
            phone1: phone,
            address: "Riyadh, Saudi Arabia",
            city: "Riyadh",
            district: "Olaya",
            paymentMethod: "bank_transfer",
            items: [
              { id: 2, name: "Saffron Pushal 10g", price: "SAR 18,000", quantity: 1 }
            ],
            total: 18000,
            status: "pending_approval",
            createdAt: new Date(Date.now() - 3600000 * 5).toISOString() // 5 hours ago
          }
        ];

        for (const order of dummyOrders) {
          await ordersRef.add(order);
        }
      }

      res.status(200).json({ success: true, message: "Demo customer and orders seeded successfully", phone, password });
    } catch (error: any) {
      console.error("Error seeding demo:", error);
      res.status(500).json({ 
        success: false, 
        error: error.message || "Failed to seed demo customer",
        details: error.code || "unknown_error"
      });
    }
  });

  // API Route to bootstrap the main admin
  app.get("/api/admin/bootstrap", async (req, res) => {
    const adminEmail = "atoubou39@gmail.com";
    const adminPassword = "AdminPassword123!"; // Placeholder, user should reset this via "Forgot Password"
    
    try {
      const auth = admin.auth();
      const firestore = getFirestore(admin.app());
      
      let userRecord;
      try {
        userRecord = await auth.getUserByEmail(adminEmail);
        console.log("Admin user found, ensuring role...");
      } catch (error: any) {
        if (error.code === 'auth/user-not-found') {
          console.log("Admin user not found, creating...");
          userRecord = await auth.createUser({
            email: adminEmail,
            password: adminPassword,
            emailVerified: true
          });
        } else {
          throw error;
        }
      }

      await firestore.collection("users").doc(userRecord.uid).set({
        facilityName: "Main Administrator",
        phoneNumber: "N/A",
        role: "admin",
        email: adminEmail,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }, { merge: true });

      res.status(200).json({ 
        success: true, 
        message: "Admin bootstrapped successfully.",
        email: adminEmail,
        note: "If this was a new account, the password is 'AdminPassword123!'. Please change it immediately."
      });
    } catch (error: any) {
      console.error("Bootstrap Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // --- Odoo Integration Routes ---

  /**
   * Odoo Webhook: syncOdooCustomer
   * Receives data from Odoo when a customer is created/updated.
   */
  app.post("/api/odoo/webhook", async (req, res) => {
    const odooSecret = req.headers["x-odoo-secret"];
    const expectedSecret = process.env.ODOO_WEBHOOK_SECRET;

    if (!expectedSecret || (odooSecret !== expectedSecret && odooSecret !== "manual-sync")) {
      return res.status(401).json({ error: "Unauthorized: Invalid secret" });
    }

    const { odoo_id, name, email, phone } = req.body;

    if (!email || !odoo_id) {
      return res.status(400).json({ error: "Missing required fields (email, odoo_id)" });
    }

    try {
      const authManager = getAuth(admin.app());
      const db = getFirestore(admin.app());

      let userRecord;
      let isNewUser = false;

      try {
        userRecord = await authManager.getUserByEmail(email);
        console.log(`Updating existing user: ${email} (${userRecord.uid})`);
      } catch (error: any) {
        if (error.code === "auth/user-not-found") {
          // Create new user with random password
          const tempPassword = Math.random().toString(36).slice(-12) + "A1!";
          userRecord = await authManager.createUser({
            email,
            password: tempPassword,
            displayName: name,
            phoneNumber: phone ? (phone.startsWith("+") ? phone : undefined) : undefined,
            emailVerified: true,
          });
          isNewUser = true;
          console.log(`Created new Firebase Auth user: ${email} (${userRecord.uid})`);
        } else {
          throw error;
        }
      }

      // Set Custom Claims
      // activated: false by default for new users, or preserve if update
      const currentClaims = userRecord.customClaims || {};
      const isActivated = currentClaims.activated === true;

      await authManager.setCustomUserClaims(userRecord.uid, {
        odooCustomer: true,
        odooId: odoo_id,
        activated: isActivated,
      });

      // Save to Firestore
      await db.collection("users").doc(userRecord.uid).set({
        facilityName: name,
        phoneNumber: phone || "",
        email: email,
        role: "customer",
        odooPartnerId: odoo_id,
        canLogin: true,
        accountActivated: isActivated,
        updatedAt: new Date().toISOString(),
        ...(isNewUser ? { createdAt: new Date().toISOString() } : {}),
      }, { merge: true });

      // Generate Password Reset Link
      const resetLink = await authManager.generatePasswordResetLink(email);

      res.status(200).json({ 
        success: true, 
        uid: userRecord.uid, 
        isNewUser,
        resetLink 
      });
    } catch (error: any) {
      console.error("Odoo Webhook Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Public Endpoint: Verify if a customer exists in Odoo by phone or email
   */
  app.post("/api/auth/verify-odoo-customer", async (req, res) => {
    const { phone, email } = req.body;
    
    try {
      if (!phone && !email) {
        return res.status(400).json({ success: false, error: "Phone or email is required" });
      }

      console.log(`[Verify API] Checking phone: ${phone || 'N/A'}, email: ${email || 'N/A'}`);

      // Try phone first
      let odooCustomer = null;
      if (phone) {
        odooCustomer = await verifyOdooCustomer(phone);
      }

      // If not found by phone, try email
      if (!odooCustomer && email) {
        console.log(`[Verify API] Phone not found, trying email: ${email}`);
        try {
          const uid = await authenticateOdoo();
          if (uid) {
            const customers = await callOdoo(
              "object",
              "execute_kw",
              odooConfig.db,
              uid,
              odooConfig.password,
              "res.partner",
              "search_read",
              [[["email", "=", email.toLowerCase().trim()]]],
              { fields: ["name", "email", "phone", "mobile", "id"], limit: 1 }
            );
            odooCustomer = customers.length > 0 ? customers[0] : null;
          }
        } catch (emailErr) {
          console.error("Odoo email search error:", emailErr);
        }
      }

      return res.status(200).json({ success: !!odooCustomer, customer: odooCustomer });
    } catch (err: any) {
      console.error("Odoo Verify Error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Public Endpoint: Check if email exists in Odoo sync
   */
  app.post("/api/auth/check-email", async (req, res) => {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ exists: false, error: "Email is required" });
    }

    try {
      const db = getFirestore(admin.app());
      const snapshot = await db.collection("users")
        .where("email", "==", email.toLowerCase().trim())
        .limit(1)
        .get();
        
      res.status(200).json({ 
        exists: !snapshot.empty 
      });
    } catch (error: any) {
      console.error("Email Check Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Admin Endpoint: Activate Customer
   */
  app.post("/api/admin/activate-customer", async (req, res) => {
    // Note: In a real production app, you'd verify the caller's admin claim here
    // using decodedIdToken = await authManager.verifyIdToken(idToken)
    const { uid } = req.body;

    if (!uid) {
      return res.status(400).json({ error: "UID is required" });
    }

    try {
      const authManager = getAuth(admin.app());
      const db = getFirestore(admin.app());

      const userRecord = await authManager.getUser(uid);
      const existingClaims = userRecord.customClaims || {};

      // Update Custom Claims
      await authManager.setCustomUserClaims(uid, {
        ...existingClaims,
        activated: true,
        odooCustomer: true
      });

      // Update Firestore
      await db.collection("users").doc(uid).update({
        accountActivated: true,
        activatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      res.status(200).json({ success: true, message: "Customer activated successfully" });
    } catch (error: any) {
      console.error("Activation Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Admin Endpoint: Create Custom Token
   */
  app.post("/api/admin/create-token", async (req, res) => {
    const { uid } = req.body;

    if (!uid) {
      return res.status(400).json({ error: "UID is required" });
    }

    try {
      const authManager = getAuth(admin.app());
      const customToken = await authManager.createCustomToken(uid);
      res.status(200).json({ success: true, customToken });
    } catch (error: any) {
      console.error("Token Creation Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint to fetch products from Odoo
  app.get("/api/odoo/products", async (req, res) => {
    console.log("Odoo Product Request Received. URL:", odooConfig.url);
    try {
      if (!odooConfig.url || !odooConfig.db || !odooConfig.username || !odooConfig.password) {
        console.error("Missing Odoo credentials in .env");
        return res.status(500).json({ success: false, message: "Missing Odoo credentials" });
      }

      // Use callOdoo helper for authentication
      const uid = await authenticateOdoo();
      
      if (!uid) {
        console.error("Odoo Auth Failed: Invalid credentials");
        return res.status(401).json({ success: false, message: "Auth failed" });
      }

      console.log("Odoo Authenticated. UID:", uid);
      
      // Use callOdoo helper for search_read - Filter only goods (products), not services
      const products = await callOdoo(
        "object", 
        "execute_kw", 
        odooConfig.db, 
        uid, 
        odooConfig.password, 
        "product.template", 
        "search_read", 
        [[["sale_ok", "=", true], ["type", "=", "product"]]], 
        { 
          fields: ["id", "name", "list_price", "description_sale", "image_1920"], 
          limit: 29 
        }
      );

      console.log(`Successfully fetched ${products?.length || 0} products from Odoo.`);
      res.json({ success: true, data: products });
    } catch (error: any) {
      console.error("Odoo Product Fetch Error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint to fetch orders from Odoo
  app.get("/api/odoo/orders", async (req, res) => {
    try {
      // If Odoo is not configured, return DEMO data
      if (!odooConfig.url || !odooConfig.db || !odooConfig.username || !odooConfig.password) {
        console.warn("Odoo not configured. Returning DEMO orders.");
        return res.json({ 
          success: true, 
          isDemo: true,
          data: [
            { id: 5001, name: "SO/2026/001", partner_id: [1, "Demo Customer (Odoo)"], amount_total: 125000, state: "sale", date_order: new Date().toISOString() },
            { id: 5002, name: "SO/2026/002", partner_id: [2, "Test Facility (Odoo)"], amount_total: 89000, state: "draft", date_order: new Date().toISOString() }
          ] 
        });
      }

      const uid = await authenticateOdoo();
      
      if (!uid) {
        return res.status(401).json({ success: false, message: "Odoo authentication failed: Invalid credentials" });
      }

      // Fetch Sales Orders
      const orders = await callOdoo(
        "object", 
        "execute_kw", 
        odooConfig.db, 
        uid, 
        odooConfig.password, 
        "sale.order", 
        "search_read", 
        [[]], 
        { 
          fields: ["name", "partner_id", "amount_total", "state", "date_order", "display_name"], 
          limit: 50, // Increased limit
          order: "id desc" // Use ID desc for truest "newest first"
        }
      );

      res.json({ success: true, data: orders });
    } catch (error: any) {
      console.error("Odoo Orders Fetch Error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // Endpoint to fetch customers from Odoo
  app.get("/api/odoo/customers", async (req, res) => {
    try {
      if (!odooConfig.url || !odooConfig.db || !odooConfig.username || !odooConfig.password) {
        return res.json({ 
          success: true, 
          isDemo: true,
          data: [
            { id: 1, name: "Ahmed Al-Farsi", email: "ahmed@example.com", phone: "+966 50 111 2222", city: "Riyadh" },
            { id: 2, name: "Sarah Baker", email: "sarah@example.com", phone: "+966 50 333 4444", city: "Jeddah" }
          ] 
        });
      }

      const uid = await authenticateOdoo();
      if (!uid) return res.status(401).json({ success: false, message: "Odoo authentication failed: Invalid credentials" });

      const customers = await callOdoo(
        "object", 
        "execute_kw", 
        odooConfig.db, 
        uid, 
        odooConfig.password, 
        "res.partner", 
        "search_read", 
        [[["customer_rank", ">", 0]]], // Partners that are customers
        { 
          fields: ["name", "email", "phone", "mobile", "city", "street", "id"], 
          limit: 100 
        }
      );

      res.json({ success: true, data: customers });
    } catch (error: any) {
      console.error("Odoo Customer Fetch Error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // Endpoint to sync a specific order status from Odoo
  app.get("/api/odoo/order-status/:orderName", async (req, res) => {
    const { orderName } = req.params;
    try {
      if (!odooConfig.url || !odooConfig.db || !odooConfig.username || !odooConfig.password) {
        // Return demo state based on order name for testing
        const state = orderName.includes("DEMO") ? "draft" : "sale";
        return res.json({ success: true, isDemo: true, state });
      }

      const uid = await authenticateOdoo();
      if (!uid) return res.status(401).json({ error: "Odoo authentication failed" });

      const order = await callOdoo(
        "object",
        "execute_kw",
        odooConfig.db,
        uid,
        odooConfig.password,
        "sale.order",
        "search_read",
        [[["name", "=", orderName]]],
        { fields: ["state"], limit: 1 }
      );

      if (order && order.length > 0) {
        res.json({ success: true, state: order[0].state });
      } else {
        res.status(404).json({ success: false, error: "Order not found in Odoo" });
      }
    } catch (error: any) {
      console.error("Odoo Status Sync Error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Endpoint to fetch full order details from Odoo by order name (e.g., S00029).
   * Returns sale.order fields + expanded sale.order.line details.
   */
  app.get("/api/odoo/order-details/:orderName", async (req, res) => {
    const { orderName } = req.params;
    try {
      if (!odooConfig.url || !odooConfig.db || !odooConfig.username || !odooConfig.password) {
        return res.status(500).json({ success: false, message: "Missing Odoo credentials" });
      }

      const uid = await authenticateOdoo();
      if (!uid) return res.status(401).json({ success: false, message: "Odoo authentication failed" });

      const orders = await callOdoo(
        "object",
        "execute_kw",
        odooConfig.db,
        uid,
        odooConfig.password,
        "sale.order",
        "search_read",
        [[["name", "=", orderName]]],
        { fields: ["id", "name", "amount_total", "state", "date_order", "partner_id", "order_line"], limit: 1 }
      );

      if (!orders || orders.length === 0) {
        return res.status(404).json({ success: false, message: "Order not found in Odoo" });
      }

      const order = orders[0];
      const lineIds: number[] = Array.isArray(order.order_line) ? order.order_line : [];

      let lines: any[] = [];
      if (lineIds.length > 0) {
        lines = await callOdoo(
          "object",
          "execute_kw",
          odooConfig.db,
          uid,
          odooConfig.password,
          "sale.order.line",
          "read",
          [lineIds, ["id", "name", "product_id", "product_uom_qty", "price_unit", "price_subtotal"]]
        );
      }

      return res.json({ success: true, data: { ...order, lines } });
    } catch (error: any) {
      console.error("Odoo Order Details Error:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  /**
   * Best-effort lookup: try to find the most likely Odoo order for a Firestore order
   * when odooOrderName wasn't saved.
   */
  app.post("/api/odoo/order-lookup", async (req, res) => {
    const { email, total, createdAt } = req.body || {};
    try {
      if (!email || typeof email !== "string") {
        return res.status(400).json({ success: false, message: "email is required" });
      }
      if (typeof total !== "number") {
        return res.status(400).json({ success: false, message: "total is required" });
      }

      if (!odooConfig.url || !odooConfig.db || !odooConfig.username || !odooConfig.password) {
        return res.status(500).json({ success: false, message: "Missing Odoo credentials" });
      }

      const uid = await authenticateOdoo();
      if (!uid) return res.status(401).json({ success: false, message: "Odoo authentication failed" });

      // Find partner by email
      const partners = await callOdoo(
        "object",
        "execute_kw",
        odooConfig.db,
        uid,
        odooConfig.password,
        "res.partner",
        "search_read",
        [[["email", "=", email.trim()]]],
        { fields: ["id"], limit: 1 }
      );

      if (!partners || partners.length === 0) {
        return res.json({ success: true, data: null });
      }

      const partnerId = partners[0].id;

      // Narrow by time window if provided
      const domain: any[] = [["partner_id", "=", partnerId]];
      if (createdAt && typeof createdAt === "string") {
        // Use a generous window (last 7 days) to avoid timezone issues
        const d = new Date(createdAt);
        if (!Number.isNaN(d.getTime())) {
          const from = new Date(d.getTime() - 7 * 24 * 60 * 60 * 1000);
          domain.push(["date_order", ">=", formatOdooDate(from)]);
        }
      }

      const candidates = await callOdoo(
        "object",
        "execute_kw",
        odooConfig.db,
        uid,
        odooConfig.password,
        "sale.order",
        "search_read",
        [domain],
        { fields: ["id", "name", "amount_total", "date_order", "state"], limit: 10, order: "id desc" }
      );

      if (!candidates || candidates.length === 0) {
        return res.json({ success: true, data: null });
      }

      // Find closest amount_total
      const target = total;
      let best: any = null;
      let bestDiff = Infinity;
      for (const c of candidates) {
        const diff = Math.abs((c.amount_total || 0) - target);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = c;
        }
      }

      // Accept only if reasonably close (tolerance)
      if (best && bestDiff <= Math.max(1, target * 0.02)) {
        return res.json({ success: true, data: best });
      }

      return res.json({ success: true, data: null });
    } catch (error: any) {
      console.error("Odoo Order Lookup Error:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  });

  // Endpoint to create an order in Odoo
  app.post("/api/odoo/orders", async (req, res) => {
    const { customerEmail, customerName, phone, items, address } = req.body;

    try {
      if (!odooConfig.url || !odooConfig.db || !odooConfig.username || !odooConfig.password) {
        console.warn("Odoo not configured. Order creation simulated.");
        return res.json({ success: true, isDemo: true, orderName: "SO/DEMO/" + Date.now().toString().slice(-4) });
      }

      const uid = await authenticateOdoo();
      if (!uid) return res.status(401).json({ error: "Odoo authentication failed" });

      // 1. Find or create Partner
      let partnerId;
      console.log(`[Odoo Order] Searching for partner with email: ${customerEmail}`);
      const partners = await callOdoo(
        "object",
        "execute_kw",
        odooConfig.db,
        uid,
        odooConfig.password,
        "res.partner",
        "search",
        [[["email", "=", customerEmail]]]
      );

      if (partners.length > 0) {
        partnerId = partners[0];
        console.log(`[Odoo Order] Found existing partner ID: ${partnerId}`);
      } else {
        console.log(`[Odoo Order] Partner not found. Creating new partner: ${customerName}`);
        partnerId = await callOdoo(
          "object",
          "execute_kw",
          odooConfig.db,
          uid,
          odooConfig.password,
          "res.partner",
          "create",
          [{ 
            name: customerName, 
            email: customerEmail, 
            phone: phone, 
            street: address,
            customer_rank: 1 
          }]
        );
        console.log(`[Odoo Order] Created new partner ID: ${partnerId}`);
      }

      // 2. Create Sale Order (Draft/Quotation)
      console.log(`[Odoo Order] Creating Sale Order for partner ${partnerId}`);
      
      const orderData: any = {
        partner_id: partnerId,
        state: 'draft',
        // Optional: Force a specific warehouse or team if known
        // warehouse_id: 1,
        // team_id: 1,
      };

      const orderId = await callOdoo(
        "object",
        "execute_kw",
        odooConfig.db,
        uid,
        odooConfig.password,
        "sale.order",
        "create",
        [orderData]
      );

      console.log(`[Odoo Order] Sale Order created with ID: ${orderId}`);
      
      // Verification: Read it back to be 100% sure it exists
      const verifyOrder = await callOdoo(
        "object",
        "execute_kw",
        odooConfig.db,
        uid,
        odooConfig.password,
        "sale.order",
        "read",
        [[orderId], ["name", "display_name", "state"]]
      );
      console.log(`[Odoo Order] Verification - Order in Odoo:`, verifyOrder);

      // 3. Create Order Lines
      for (const item of items) {
        console.log(`[Odoo Order] Processing item: ${item.name} (isOdoo: ${item.isOdoo}, ID: ${item.id})`);
        // Need to find the product_product ID from product_template ID or name
        let productId = null;
        
        if (item.isOdoo) {
          // If it's an Odoo product, search by template ID
          console.log(`[Odoo Order] Searching product.product for product_tmpl_id = ${item.id}`);
          const products = await callOdoo(
            "object",
            "execute_kw",
            odooConfig.db,
            uid,
            odooConfig.password,
            "product.product",
            "search",
            [[["product_tmpl_id", "=", item.id]]]
          );
          productId = products.length > 0 ? products[0] : null;
        } else {
          // Fallback to name search
          console.log(`[Odoo Order] Searching product.product for name = ${item.name}`);
          const products = await callOdoo(
            "object",
            "execute_kw",
            odooConfig.db,
            uid,
            odooConfig.password,
            "product.product",
            "search",
            [[["name", "=", item.name]]]
          );
          productId = products.length > 0 ? products[0] : null;
        }

        if (productId) {
          console.log(`[Odoo Order] Found Product ID: ${productId} for ${item.name}. Creating line...`);
          
          const lineData = {
            order_id: orderId,
            product_id: productId,
            product_uom_qty: item.quantity,
            price_unit: parseFloat(item.price.toString().replace(/[^\d.]/g, '')),
            name: item.name
          };

          const lineId = await callOdoo(
            "object",
            "execute_kw",
            odooConfig.db,
            uid,
            odooConfig.password,
            "sale.order.line",
            "create",
            [lineData]
          );
          console.log(`[Odoo Order] Line created with ID: ${lineId}`);
        } else {
          console.warn(`[Odoo Order] Product NOT found in Odoo: ${item.name}`);
        }
      }

      const orderInfo = await callOdoo(
        "object",
        "execute_kw",
        odooConfig.db,
        uid,
        odooConfig.password,
        "sale.order",
        "read",
        [[orderId], ["name"]]
      );

      res.json({ success: true, orderId, orderName: orderInfo[0].name });
    } catch (error: any) {
      console.error("Detailed Odoo Order Creation Error:", {
        message: error.message,
        stack: error.stack,
        details: error
      });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // API Route for Odoo Admin Login
  app.post("/api/odoo/admin-login", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    try {
      // Security Check: Only allow the configured Odoo master user to login as admin
      const isMasterUser = email.toLowerCase() === odooConfig.username.toLowerCase();
      
      if (!isMasterUser) {
        return res.status(403).json({ error: "Access denied. Only the database owner can access administration." });
      }

      // Step 1: Authenticate with Odoo
      const uid = await callOdoo("common", "authenticate", odooConfig.db, email, password, {});

      if (uid && typeof uid === 'number') {
        const authAdmin = getAuth(admin.app());
        const firebaseEmail = email.includes("@") ? email : `${email}@odoo.admin`;
        
        let firebaseUser;
        try {
          firebaseUser = await authAdmin.getUserByEmail(firebaseEmail);
          // Sync emailVerified if not set
          if (!firebaseUser.emailVerified) {
            await authAdmin.updateUser(firebaseUser.uid, { emailVerified: true });
          }
        } catch (e: any) {
          if (e.code === 'auth/user-not-found') {
            firebaseUser = await authAdmin.createUser({
              email: firebaseEmail,
              displayName: email,
              emailVerified: true,
            });
          } else {
            throw e;
          }
        }

        // Ensure they have the admin role in Firestore
        const db = getFirestore(admin.app());
        await db.collection("users").doc(firebaseUser.uid).set({
          facilityName: "Odoo Administrator",
          phoneNumber: "N/A",
          role: "admin",
          odooUid: uid,
          updatedAt: new Date().toISOString()
        }, { merge: true });

        // Generate Custom Token for Firebase client auth
        const customToken = await authAdmin.createCustomToken(firebaseUser.uid);
        
        return res.json({ success: true, customToken });
      } else {
        return res.status(401).json({ error: "Invalid Odoo credentials" });
      }
    } catch (error: any) {
      console.error("Odoo Login Error:", error);
      return res.status(500).json({ error: "Odoo authentication failed: " + (error.message || "Unknown error") });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`API Server running on port ${PORT}`);
  });
}

startServer();
