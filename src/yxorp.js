"use strict";


const fs = require('fs');
const http = require('http');
const https = require('https');
const util = require('util');
const constants = require('constants');
const httpProxy = require('http-proxy');
const proxyTable = require('./proxy-table.js');
const ocsp = require('ocsp');
const repl = require('repl');
const jwt = require('jsonwebtoken');

var ocspCache = new ocsp.Cache();

var table;

var config, config_file = "conf/proxyconf.json";
config_file = fs.readFileSync(config_file, "utf8");

try{ 
    config = JSON.parse(config_file);
} catch (err) {
	  console.log("error parsing config");
	  console.log("error was "+ err.message);
}



var read_routes = function(event, filename) {
    var routes_file = fs.readFileSync(config.routes);
    var routes_json;
    try {
	      routes_json = JSON.parse(routes_file);
    } catch (err) {
	      console.log("error parsing json file");
	      console.log("routes_file: ", routes_file);
	      console.log("routes_json: ", routes_json);
	      console.log("error was "+ err.message);
    }
    if (typeof(routes_json) == 'object') {
	      table = new proxyTable.ProxyTable({router: routes_json});
	      console.log("routes: ", routes_json);
    } else {
	      console.log("routes_json not an object: ", typeof(routes_json));
    }
};

read_routes();
fs.watch(config.routes, {persistent: false}, read_routes);

//
// Create a proxy server with custom application logic
//
var proxy = httpProxy.createProxyServer({
    xfwd : true
});

// I think the API changed and req and res will never be defined here
proxy.on('error', function(err, req, res) {
    console.log("prox error: ", err, req, res);
    if (res.writeHead && res.end) {
        res.writeHead(502);
        res.end("502 Bad Gateway\n\n" + JSON.stringify(err, null, "  "));
    }
});

// If it ain't Baroque, don't fix it
//proxy.on('proxyReq', function(proxyReq, req, res, options) {
//    console.log ("req", req);
//    proxyReq.setHeader('X-Forwarded-For', req.remoteAddr);
//});


var optClientAuth = {
    requestCert: true,
    rejectUnauthorized: true
};

var https_options = {
    key: fs.readFileSync(config.serverKey, 'utf8'),
    cert: fs.readFileSync(config.serverCert, 'utf8'),
    ca: parseCertChain(fs.readFileSync(config.CACerts, 'utf8')),

    // https://certsimple.com/blog/a-plus-node-js-ssl
    ciphers: [
            "ECDHE-RSA-AES256-SHA256",
            "ECDHE-RSA-AES256-SHA384",
            "DHE-RSA-AES256-SHA384",
            "DHE-RSA-AES256-SHA256",
            "ECDHE-RSA-AES128-SHA256",
            "DHE-RSA-AES128-SHA256",
            "HIGH",
            "!aNULL",
            "!eNULL",
            "!EXPORT",
            "!DES",
            "!RC4",
            "!MD5",
            "!PSK",
            "!SRP",
            "!CAMELLIA"
        ].join(':')
};

var listener = function(req, res) {
    
    console.log(  req.method, req.headers.host, req.url, req.socket.localPort);
    //* do loadable module here */
    if (req.url == '/pki/') { 
        console.log("PKI CODE ACTIVATED!");
        var socket = req.connection;
        var result = socket.renegotiate(optClientAuth, function(err){
            if (!err) {
                // catch errors - getPeerCertificate() can be undef if user something goes wrong
                var token = jwt.sign({CN: req.connection.getPeerCertificate().subject.CN,
                                      exp: Math.floor(new Date().getTime()/1000) + 7*24*60*60,
                                      iat: Math.floor(Date.now() / 1000) - 30 },
                                     https_options.key);
                console.log('jwt:', token);
                
                res.setHeader('Set-Cookie', ['jwt='+token+'; Path=/; Secure']);   
                //console.log(req.connection.getPeerCertificate());
               
                
                res.writeHead(200);
                
                res.end("<pre>"
                        +JSON.stringify(req.connection.getCipher(),null, "  ")
                        +"\n"
                        +JSON.stringify(req.connection.getPeerCertificate(),null, "  ")
                        +"</pre>"
                        +"Authenticated Hello World\n");

                
            } else {
                console.log(err.message);
            }
        });
        return;
    }

    if (!req.headers.host && config.defaultTarget) {
        req.headers.host = config.defaultTarget;
    }

    var target = table.getProxyLocation(req);
    console.log( 'target: ', target );


    if (null == target) {
        console.log ("UNMATCHED request: ", req.url);
        res.writeHead(502);
        res.end("502 Bad Gateway\n\n" + "UNMATCHED request: "+ req.url);
    } else {
        proxy.web(req, res, { target: target });
    }

};

//
// Create your custom server and just call `proxy.web()` to proxy 
// a web request to the target passed in the options
// also you can use `proxy.ws()` to proxy a websockets request
//

function parseCertChain(chain) {
    chain = chain.split('\n');
    var ca = [];
    var cert = [];
    var line;
    while (chain.length > 0) {
        line = chain.shift();
        cert.push(line); 
        if (line.match(/-END CERTIFICATE-/)) {
            ca.push(cert.join('\n'));
            cert = [];
        }
    }
    return ca;
}


//console.log(https_options);

var server = http.createServer(listener).listen(80);
var httpsServer = https.createServer(https_options, listener).listen(443);

// Simpleminded TLS session store
// This leaks memory I think, in that it never forgets old sessions
// 
var tlsSessionStore = {};
httpsServer.on('newSession', function(id, data, cb) {
    console.log("new tls session", id);
    tlsSessionStore[id] = data;
    cb();
});
httpsServer.on('resumeSession', function(id, cb) {
    console.log("resume tls session", id);
    cb(null, tlsSessionStore[id] || null);
});

httpsServer.on('tlsClientError', function(e, socket) {
    console.log("tlsClientError - ", e.message);
});

//console.log(httpsServer);

ocsp.getOCSPURI(https_options.cert, function(err, uri) { 
    if( err ) {
        console.log("No OCSP URI, disabling OCSP: ", err);
    } else {
        httpsServer.on('OCSPRequest', function(cert, issuer, cb) {
            console.log("OCSP request");
            ocsp.getOCSPURI(cert, function(err, uri) {
                console.log("OCSP cert", cert);
                console.log("OCSP issuer", issuer);
                
                if (err) {
                    return cb(err);
                }        
                
                var req = ocsp.request.generate(cert, issuer);
                var options = {
                    url: uri,
                    ocsp: req.data
                };
                
                ocspCache.probe(req.id, function(e, res) {
                    if (res) {
                        console.log("OCSP hit", req.id);                
                        return cb(null, res.response);
                    }
                    ocspCache.request(req.id, options, function(a,b) {
                        console.log("OCSP miss", req.id);
                        cb(a,b);
                    });
                });
                
            });
        });
    }
});


//
// Listen to the `upgrade` event and proxy the 
// WebSocket requests as well.
//

var upgrade = function (req, socket, head) {
    console.log("UPGRADE", req.url, socket.localPort);
    var target = table.getProxyLocation(req);
    if (null != target) {
	      proxy.ws(req, socket, head, {target: target});
    }
};

server.on('upgrade', upgrade);
httpsServer.on('upgrade', upgrade);



var mods = {};
var mod_names = [];
var modDir = "/modules/";
var lastErr; 

function loadMod(modName) {
    //     // What if the module was already loaded?  Reload it, I guess.
    unloadMod(modName);
    
    var path = process.cwd()+modDir+modName;
    try {
        console.log("begin loading "+modName);
        mods[modName] = require(path);
        mod_names.push(modName);
        if (typeof mods[modName]['load'] == 'function') {
            console.log("calling load "+modName);
            mods[modName]['load'](this);
        }
        console.log("done loading "+modName);
    } catch (e) {
        console.log("error while loading module "+modName);
        console.log(e);
        lastErr = e;
        return e;
    }
    return;
}

function unloadMod(modName) {
    console.log("req unload '%s'",modName);
    if (mods[modName]) {
        if (typeof mods[modName]['unload'] == 'function') {
            console.log("calling unload "+modName);
            try {
                mods[modName]['unload'](this);
            } catch (e) {
                console.log("error while loading module "+modName);
                console.log(e);
                lastErr = e;
                // don't return the error because we still should try to unload it.
                // return e;
            }
        }
        delete mods[modName];
        var index = mod_names.indexOf(modName);    
        if (index !== -1) {
            mod_names.splice(index, 1);
        }
    }
    var path = process.cwd()+modDir+modName;
    if (! /\.js$/.test(path)) { path += '.js'; };
    console.log("path to unload: ",path);
    path = require.resolve(path);
    console.log("resovled path to unload: ",path);

    if (require.cache[path]) {
        delete require.cache[path];
    };
}



function testResolve(path) {
    console.log(require.resolve(path));
//    console.log(require);
}

// start REPL 

const r = repl.start('> ');
Object.defineProperty(r.context, 'loadMod', {
  configurable: false,
  enumerable: true,
  value: loadMod
});
Object.defineProperty(r.context, 'testResolve', {
  configurable: false,
  enumerable: true,
  value: testResolve
});
Object.defineProperty(r.context, 'unloadMod', {
  configurable: false,
  enumerable: true,
  value: unloadMod
});
// end REPL
