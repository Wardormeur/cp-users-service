(function () {
   'use strict';
    var exec = require('child_process').exec;
    var _ = require('lodash');

    var argv = require('optimist')
      .boolean('d')
      .alias('d', 'withcleanup')
      .argv;

    //  TODO : unify bootstrapper to be js only, no more bash please.
    //  For reference for config files : var nconf = require('nconf')

    var usage = 'Usage: ./index <setup||start> <envFile>';
    var action = argv._[0];
    var envFile = argv._[1];
    if (!action || !envFile) return console.log(usage);
    switch(action){
      case 'setup':
        setup();
        break;
      case 'start':
        startStack();
      break;
    }

    function setup () {
      var setupDB = 'node migrate-psql-db.js';
      var setupData = 'scripts/load_test_data.sh ' + envFile;

      var proc = command(setupDB, null, {}, function(){
        command(setupData, null, {}, startStack);
      });
    }

    function startStack () {
      console.log('Starting stack');
      var config = 'config/' + envFile+'.env';
      var cmd = 'source ' + config + ' && ./start.sh config/empty.env service.js';
      var proc = command(cmd, null, {}, function(){
        console.log('Service shutdowned');
      });
    }

    function command (cmd, cwd, env, cb) {
      var proc = exec(cmd, {}, function (err, stdout, stderr) {
        if (err) return cb('Error running command: ' + cmd + ' - ' + err + ' - ' + err.stack + ' - ' + stderr);
        cb();
      });
      proc.stdout.pipe(process.stdout);
      proc.stderr.pipe(process.stderr);
      return proc;
    }
}());
