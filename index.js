const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");


const dns = require("dns");
const { userInfo } = require("os");
dns.setServers(["8.8.8.8", "1.1.1.1"]);

// ---- ENV CHECK (temporary debug log, safe to remove later) ----
// console.log("ENV CHECK:", {
//   hasStripe: !!process.env.STRIPE_KEY,
//   hasFB: !!process.env.FB_SERVICE_KEY,
//   hasDbUser: !!process.env.DB_USER,
//   hasDbPass: !!process.env.DB_PASS,
//   hasDomain: !!process.env.MY_DOMAIN,
// });
// -----------

const stripe = require("stripe")(process.env.STRIPE_KEY);

// Firebase Admin
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

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
const { log } = require("console");

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
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");
    const trackingCollections = db.collection("trackings");

    // middleware for database access(admin)
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // tracking log
    const logTracking = async(trackingId, status) =>{
      const log = {
        status,
        trackingId,
        details:status.split('-').join(' '),
        createdAt: new Date()
      }
      const result = await trackingCollections.insertOne(log);
      return result
    }

    // users related apis
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;

      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        return res.send({ message: "user exists" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.get("/users", async (req, res) => {
      try {
        const { searchText } = req.query;

        let query = {};

        if (searchText) {
          query = {
            $or: [
              {
                name: {
                  $regex: searchText,
                  $options: "i",
                },
              },
              {
                email: {
                  $regex: searchText,
                  $options: "i",
                },
              },
            ],
          };
        }

        const users = await usersCollection.find(query).toArray();

        res.send(users);
      } catch (error) {
        console.error(error);
        res.status(500).send({
          message: "Failed to fetch users",
        });
      }
    });

    app.patch("/users/:id/role", verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const { role } = req.body;

      const query = { _id: new ObjectId(id) };

      const result = await usersCollection.updateOne(query, {
        $set: { role },
      });

      res.send(result);
    });

    // role related apis
    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    // riders related apis
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pendding";
      rider.createdAt = new Date();

      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    app.get("/riders", async (req, res) => {
      const { status, workStatus, district } = req.query;
      const query = {};
      if (status) {
        query.status = status;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      if (district) {
        query.district = district;
      }
      const cursor = ridersCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.patch("/riders/:id", verifyFBToken, async (req, res) => {
      try {
        const status = req.body.status;
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };

        const updatedDoc = {
          $set: {
            status: status,
            workStatus: "available",
          },
        };

        const result = await ridersCollection.updateOne(query, updatedDoc);

        if (status === "approved") {
          const email = req.body.email;
          const userQuery = { email };
          const updateUser = {
            $set: {
              role: "rider",
            },
          };
          const userResult = await usersCollection.updateOne(
            userQuery,
            updateUser,
          );
        }
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to update rider status" });
      }
    });

    app.delete("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await ridersCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to delete rider" });
      }
    });

    // parcels related apis

    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email, penddingStatus } = req.query;

      if (penddingStatus) {
        query.penddingStatus = penddingStatus;
      }

      const options = { sort: { createdAt: -1 } };

      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/rider", async (req, res) => {
      const { riderEmail, penddingStatus } = req.query;
      const query = {};

      if (riderEmail) {
        query.riderEmail = riderEmail;
      }
      if (penddingStatus !== 'parcel-delivered') {
        // query.penddingStatus = {$in : ['driver-assigned','rider-arriving']};
        query.penddingStatus = { $nin: ["parcel-delivered"] };
      }
      else{
        query.penddingStatus = penddingStatus;
      }

      const cursor = parcelsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const { penddingStatus, riderId, trackingId } = req.body;
      const query = { _id: new ObjectId(req.params.id) };
      const updatedDoc = {
        $set: {
          penddingStatus: penddingStatus,
        },
      };
      if (penddingStatus === "parcel-delivered") {
        // update rider info

        const riderQuery = { _id: new ObjectId(riderId) };
        const riderUpdateDoc = {
          $set: {
            workStatus: "available",
          },
        };
        const riderResult = await ridersCollection.updateOne(
          riderQuery,
          riderUpdateDoc,
        );
      }
      const result = await parcelsCollection.updateOne(query, updatedDoc);
      // log tracking
      logTracking(trackingId, penddingStatus);
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

    // assign riders for parels
    app.patch("/parcels/:id", async (req, res) => {
      const { riderId, riderEmail, riderName, trackingId } = req.body;

      const id = req.params.id;

      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: {
          penddingStatus: "driver-assigned",
          riderId: riderId,
          riderEmail: riderEmail,
          riderName: riderName,
        },
      };

      const ParcelResult = await parcelsCollection.updateOne(query, updateDoc);

      // update rider info

      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdateDoc = {
        $set: {
          workStatus: "in-delivary",
        },
      };
      const riderResult = await ridersCollection.updateOne(
        riderQuery,
        riderUpdateDoc,
      );

      // log tracking

      logTracking(trackingId, 'driver-assigned');
      res.send(riderResult);
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
            penddingStatus: "pendding-pickup",
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

          // log tracking

          logTracking(trackingId, 'pendding-pickup');

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

        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Forbidden access" });
        }
      }
      const cursor = paymentCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // trackings related apis
    app.get('/trackings/:trackingId/logs', async(req, res) =>{
      const trackingId = req.params.trackingId;
      const query = {trackingId};
      const result = await trackingCollections.find(query).toArray();
      res.send(result);
    })

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!",
    // );
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

module.exports = app;
