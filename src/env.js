// Loads vars.env into process.env. Must be required first.
const { ROOT_DIR } = require('./paths');

// for all who enter here
// this code holds up with hopes and dreams
// even AI doesn't fully understand it
// if you decide to edit this and spend time suffering
// please leave your name below

// Onogen

// Absolute path on purpose: a relative 'vars.env' is resolved against the process's working
// directory.
require('dotenv').config({ path: require('path').join(ROOT_DIR, 'vars.env') });
