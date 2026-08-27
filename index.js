const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_KEY);

const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

app.use(express.json());
app.use(cors());

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

    app.post("checkout-payment-session", async (req, res) => {
      const parcelInfo = req.body;

      if (
        !data.cost ||
        !data.parcelId ||
        !data.senderEmail ||
        !data.parcelName
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
                product_data: parcelInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          parcelId: parcelInfo.parcelId,
        },
        customer_email: parcelInfo.senderEmail,
        success_url: `${process.env.MY_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancelled_url: `${process.env.MY_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
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
