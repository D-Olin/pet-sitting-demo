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
  layoutsDir: __dirname + "../../views/layouts",
  partialsDir: __dirname + "../../views/partials",
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


// -------------------------------------  Auth Middleware   ---------------------------------------

// Middleware to check if the user is logged in
function isLoggedIn(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).send("You are not logged in");
    }
    next();
}

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

    
module.exports = function(app) {

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

};