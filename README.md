<h1><div align="center"><img src="public/Ellie.png" height="256"></div></h1>

Biodeck is a twitter like social media website, but open source and just better

## What it uses
- nodejs
- express
- html5
- css3
- better-sqlite3
- dotenv
- nodemailer
- bcrypt
- multer
- sharp
- mailparser

## How it works
- ``server.js``: Main server
- ``src``: Modules
- ``html files``: HTML files
- ``vars.env``: Environment variables (for nodemailer, rename vars.env.public to vars.env and put your info in it)
- ``activation-pings.txt``: Users that will be pinged on user creation (When registration gate is on)
- ``public``: Public folder
    - ``uploads``: Uploads
    - ``v86``: v86

For APIs refer to Documentation/APIs.md<br>
For setup instructions refer to Documentation/setup.md
