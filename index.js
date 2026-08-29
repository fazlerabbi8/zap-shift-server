const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_KEY);

const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

// Firebase Admin
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const serviceAccount = require("./firebase-admin-sdk.json");

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
  });
}




app.use(express.json());
app.use(cors());

// middlewares

const verifyFBToken = async (req, res, next) => {
  // console.log('headers in the middle ware',req.headers.authorization)
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
   const decoded = await getAuth().verifyIdToken(idToken);
    console.log("decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
   
  } catch (err) {
    console.error("Token verification error:", err);

    return res.status(401).send({
      message: "Invalid or expired token",
    });
  }
};

// generate a tracking id
const crypto = require("crypto");

function generateTrackingId(prefix = "PKG") {
  const date = new Date();
  const datePart = date.toISOString().slice(2, 10).replace(/-/g, ""); // YYMMDD
  const randomPart = crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 hex chars

  return `${prefix}-${datePart}-${randomPart}`;
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.edjhlsi.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("zap-shift-db");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");

    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;

      const options = { sort: { createdAt: -1 } };

      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    // payment api(stripe)

    app.post("/checkout-payment-session", async (req, res) => {
      const parcelInfo = req.body;

      if (
        !parcelInfo.cost ||
        !parcelInfo.parcelId ||
        !parcelInfo.senderEmail ||
        !parcelInfo.parcelName
      ) {
        return res
          .status(400)
          .send({ error: "Missing required payment information" });
      }

      const amount = Math.round(parseFloat(parcelInfo.cost) * 100);

      if (isNaN(amount) || amount <= 0) {
        return res.status(400).send({ error: "Invalid cost value" });
      }

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: parcelInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          parcelId: parcelInfo.parcelId,
          parcelName: parcelInfo.parcelName,
        },
        customer_email: parcelInfo.senderEmail,
        success_url: `${process.env.MY_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.MY_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    app.patch("/payment-sucess", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      // console.log(session)

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollection.findOne(query);

      if (paymentExist) {
        return res.send({
          message: "already exists",
          transactionId,
          trackingId: paymentExist.trackingId,
          parcelName: session.metadata.parcelName,
        });
      }

      const trackingId = generateTrackingId();

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            trackingId: trackingId,
            parcelName: session.metadata.parcelName,
          },
        };
        const result = await parcelsCollection.updateOne(query, update);

        const paymentInfo = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        if (session.payment_status === "paid") {
          const paymentResult = await paymentCollection.insertOne(paymentInfo);
          res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentInfo: paymentResult,
            parcelName: session.metadata.parcelName,
          });
        }
      }

      res.send({ success: false });
    });

    // payment related apis
    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      // console.log(req.headers);

      if (email) {
        query.customerEmail = email;

        if(email !== req.decoded_email){
          return res.status(403).send({message: 'Forbidden access'})
        }
      }
      const cursor = paymentCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // app.post("/create-checkout-session", async (req, res) => {
    //   try {
    //     const data = req.body;

    //     // Validate required fields
    //     if (
    //       !data.cost ||
    //       !data.parcelId ||
    //       !data.senderEmail ||
    //       !data.parcelName
    //     ) {
    //       return res
    //         .status(400)
    //         .send({ error: "Missing required payment information" });
    //     }

    //     // Convert cost to cents, correctly handling decimals
    //     const amount = Math.round(parseFloat(data.cost) * 100);

    //     if (isNaN(amount) || amount <= 0) {
    //       return res.status(400).send({ error: "Invalid cost value" });
    //     }

    //     const session = await stripe.checkout.sessions.create({
    //       line_items: [
    //         {
    //           price_data: {
    //             currency: "usd", // lowercase, as Stripe expects
    //             unit_amount: amount, // now correctly in cents
    //             product_data: {
    //               name: data.parcelName,
    //             },
    //           },
    //           quantity: 1,
    //         },
    //       ],
    //       customer_email: data.senderEmail,
    //       mode: "payment",
    //       metadata: {
    //         parcelId: data.parcelId,
    //       },
    //       success_url: `${process.env.MY_DOMAIN}/dashboard/payment-success`,
    //       cancel_url: `${process.env.MY_DOMAIN}/dashboard/payment-canceled`,
    //     });

    //     res.send({ url: session.url });
    //   } catch (err) {
    //     console.error("Stripe session creation failed:", err);
    //     res.status(500).send({ error: err.message });
    //   }
    // });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("zap shift running.......");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
