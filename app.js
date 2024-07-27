const express = require("express");
const app = express();
const path = require("path");

console.log("Public directory:", path.join(__dirname, "public"));
app.use(express.static("public"));

const handlebars = require("express-handlebars");
const pgp = require("pg-promise")();
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");

const session = require("express-session");

// -------------------------------------  APP CONFIG   ----------------------------------------------
// create `ExpressHandlebars` instance and configure the layouts and partials dir.
const hbs = handlebars.create({
  extname: "hbs",
  layoutsDir: __dirname + "/views/layouts",
  partialsDir: __dirname + "/views/partials",
  helpers: {
    ifEquals: function (arg1, arg2, options) {
      return arg1 == arg2 ? options.fn(this) : options.inverse(this);
    },
  },
});

// Register `hbs` as our view engine using its bound `engine()` function.
app.engine("hbs", hbs.engine);
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));
app.use(bodyParser.json());
// set Session
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    saveUninitialized: true,
    resave: true,
  })
);
app.use(
  bodyParser.urlencoded({
    extended: true,
  })
);

// -------------------------------------  DB CONFIG AND CONNECT   ---------------------------------------
const dbConfig = {
  host: process.env.HOST,
  port: 5432,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
};
const db = pgp(dbConfig);

// db test
db.connect()
  .then((obj) => {
    console.log("Database connection successful");
    obj.done();
  })
  .catch((error) => {
    console.error("Database connection error:", error);
    console.error("Connection details:", {
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      user: dbConfig.user,
    });
  });

// db check if table exists
db.query("SELECT * FROM job_post")
  .then((result) => {
    console.log("Table exists");
  })
  .catch((error) => {
    console.error("Table does not exist:", error);
  });

// -------------------------------------  ROUTES   ---------------------------------------

app.get("/", (req, res) => {
  res.send("Example website");
});

app.get("/register", (req, res) => {
  res.render("pages/register");
});

app.get("/login", (req, res) => {
  res.render("pages/login");
});

// -------------------------------------  REGISTER   ---------------------------------------

app.post("/register", async (req, res) => {
  const { name, email, password, location } = req.body;
  const type = req.query.type;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await db.one(
      `INSERT INTO app_user (name, email, password_hash, type, location)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, email, hashedPassword, type, location]
    );

    if (type === "employer") {
      await db.none(
        `INSERT INTO employer (user_id, budget)
            VALUES ($1, $2)`,
        [newUser.id, 0]
      );
    }

    if (type === "freelancer") {
      await db.none(
        `INSERT INTO freelancer (user_id, bio, profile_picture)
            VALUES ($1, $2, $3)`,
        [newUser.id, "new freelancer", "default.jpg"]
      );
    }

    req.session.userId = newUser.id;
    req.session.userType = type;
    res.send(`
                <script>
                    alert('Registration successful');
                    setTimeout(function() {
                    window.location.href = '/login';
                    }, 1000);
                </script>
        `);
  } catch (error) {
    console.log(error);
    res.status(500).send("Error in user registration");
  }
});

// -------------------------------------  LOGIN   ---------------------------------------

const secretKey = process.env.SESSION_SECRET;

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await db.oneOrNone("SELECT * FROM app_user WHERE email = $1", [
      email,
    ]);
    if (user && (await bcrypt.compare(password, user.password_hash))) {
      req.session.userId = user.id; // Set user ID in session
      req.session.userType = user.type; // Set user type in session
      req.session.email = user.email; // Set user email in session
      if (user.type === "freelancer") {
        res.redirect("/jobs");
      }
      if (user.type === "employer") {
        res.redirect("/edit-profile");
      }
    } else {
      res.status(401).send("Invalid credentials");
    }
  } catch (error) {
    console.log(error);
    res.status(500).send("Error logging in");
  }
});

// -------------------------------------  LOGOUT   ---------------------------------------

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(400).send("Unable to log out");
    }
    res.send(`
                <script>
                    alert('Logout successful');
                    setTimeout(function() {
                    window.location.href = '/login';
                    }, 1000);
                </script>
        `);
  });
});

// -------------------------------------  Auth Middleware   ---------------------------------------

// Middleware to check if the user is logged in
function isLoggedIn(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).send("You are not logged in");
  }
  next();
}

// -------------------------------------  JOB LISTING   ---------------------------------------

app.get("/jobs", isLoggedIn, async (req, res) => {
  try {
    const query = `
                SELECT 
                    jp.id,
                    jp.title,
                    jp.description,
                    TO_CHAR(jp.date_start, 'MM/DD/YYYY') AS date_start,
                    TO_CHAR(jp.date_end, 'MM/DD/YYYY') AS date_end,
                    jp.status,
                    jp.hourly_rate,
                    e.name AS employer_name,
                    e.location,
                    p.name AS pet_name,
                    p.pet_type
                FROM 
                    JOB_POST jp
                JOIN 
                    EMPLOYER emp ON jp.employer_id = emp.id
                JOIN 
                    APP_USER e ON emp.user_id = e.id
                JOIN 
                    PET p ON jp.pet_id = p.id
                WHERE 
                    jp.status = 'open'
                ORDER BY 
                    jp.created_at DESC
            `;

    const jobs = await db.any(query);

    // Render the job board template with the jobs data
    res.render("pages/job_listing", { jobs, email: req.session.email });
  } catch (err) {
    console.error("Error fetching job posts:", err);
    res.status(500).send("Server error");
  }
});

// -------------------------------------  PROFILE EDIT - EMPLOYERS   ---------------------------------------

app.get("/edit-profile", isLoggedIn, async (req, res) => {
  const userId = req.session.userId;
  if (req.session.userType == "employer") {
    try {
      // Fetch the current profile data from the database
      const userData = await db.one(` SELECT a.name, a.location, e.budget, e.id FROM app_user a JOIN employer e ON a.id = e.user_id WHERE a.id = $1`, [userId] );
      // Render the Handlebars template with the fetched data
      res.render("pages/edit-profile", {
        user: {
          name: userData.name,
          location: userData.location,
          type: req.session.userType,
        },
        employer: {
          budget: userData.budget,
          id:userData.id
        },
        email: req.session.email,
      });
    } catch (error) {
      console.log(error);
      res.status(500).send("Error fetching profile data");
    }
  }
  if (req.session.userType == "freelancer") {
    try {
      // Fetch the current profile data from the database
      const userData = await db.one(
        `
          SELECT a.name, a.location, f.bio, f.profile_picture
          FROM app_user a
          INNER JOIN freelancer f ON a.id = f.user_id
          WHERE a.id = $1`,
        [userId]
      );

      // Render the Handlebars template with the fetched data
      res.render("pages/edit-profile", {
        user: {
          name: userData.name,
          location: userData.location,
          type: req.session.userType,
        },
        freelancer: {
          bio: userData.bio,
          profile_picture: userData.profile_picture,
        },
        email: req.session.email,
      });
    } catch (error) {
      console.log(error);
      res.status(500).send("Error fetching profile data");
    }
  }
});

app.post("/edit-profile", isLoggedIn, async (req, res) => {
  const userId = req.session.userId;
  try {
    const name = req.body.name;
    const location = req.body.location;

    if (req.session.userType == "employer") {
      const budget = req.body.budget;

      // Validate input
      if (budget !== undefined && (isNaN(budget) || budget < 0)) {
        return res.status(400).send("Invalid budget value");
      }
      await db.tx(async (t) => {
        if (budget !== undefined) {
          await t.none(
            `UPDATE employer
              SET budget = $1
              WHERE user_id = $2`,
            [budget, userId]
          );
        }
      });
    }
    if (req.session.userType == "freelancer") {
      const bio = req.body.bio;
      const profile_picture = req.body.profile_picture;
      await db.tx(async (t) => {
        if (bio !== undefined || profile_picture !== undefined) {
          await t.none(
            `UPDATE freelancer
              SET bio = COALESCE($1, bio), profile_picture = COALESCE($2, profile_picture)
              WHERE user_id = $3`,
            [bio, profile_picture, userId]
          );
        }
      });
    }

    if (name !== undefined || location !== undefined) {
      await db.none(
        `UPDATE app_user
          SET name = COALESCE($1, name), location = COALESCE($2, location)
          WHERE id = $3`,
        [name, location, userId]
      );
    }
    res.send(`
                <script>
                    alert('Profile updated successfully');
                    setTimeout(function() {
                    window.location.href = '/edit-profile';
                    }, 500);
                </script>
        `);
  } catch (error) {
    console.log(error);
    res.status(500).send("Error updating profile");
  }
});



app.post("/add-pet", isLoggedIn, async (req, res) => {
  const userId = req.session.userId;
  try {
    const {pet_name,pet_type,pet_age,special_needs,employer_id} = req.body;
    // Validate input
    if (pet_name === undefined || pet_type === undefined || pet_age === undefined) {
      return res.status(400).send("Invalid Pet Input");
    }
    await db.tx(async (t) => {
      if (special_needs !== undefined) {
        await t.none(`INSERT INTO PET (owner_id,name,pet_type,age,special_needs) VALUES ($1,$2,$3,$4,$5)`, [employer_id,pet_name,pet_type,pet_age,special_needs]);
      }
      else if (special_needs === undefined) {
        await t.none(`INSERT INTO PET (owner_id,name,pet_type,age) VALUES ($1,$2,$3,$4)`, [employer_id,pet_name,pet_type,pet_age]);
      }
    });
  } 
  catch (error) {
    console.log(error);
    res.status(500).send("Error updating profile");
  }
  res.send(`
    <script>
        alert('Pet added successfully');
        setTimeout(function() {
        window.location.href = '/edit-profile';
        }, 500);
    </script>
`);
});

// -------------------------------------  SERVER START   ---------------------------------------

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});

module.exports = { app, db };
