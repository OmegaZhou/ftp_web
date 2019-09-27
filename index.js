const express = require('express')
const session = require('express-session')
const Client = require('ftp');
const body_parser = require('body-parser')
const fs = require('fs');
const error = require('./lib/error')

const API_PATH = '/ftp/api/'
var app = express();
var client_map = new Map();
app.use(session({
    secret: 'ftp_web',
    cookie: {
        maxAge: 60 * 1000 * 30
    },
    saveUninitialized: false,
    resave: false,

}))

app.use('/ftp/img', express.static(__dirname + '/img'))

app.use(body_parser.json());
app.use(body_parser.urlencoded({ extended: false }));

app.get('/ftp', function (req, res) {
    res.redirect('/ftp/login.html');
})


app.get('/ftp/login.html', function (req, res) {
    if (req.session.ftp_connection) {
        var index = req.session.id;
        if (client_map.has(index)) {
            res.redirect('/ftp/index.html')
            return;
        }
    }
    res.sendFile(__dirname + '/login.html');
})

app.get('/ftp/index.html', function (req, res) {
    if (!req.session.ftp_connection) {
        res.redirect('/ftp/login.html');
        return;
    }
    var index = req.session.id;
    if (!client_map.has(index)) {
        res.redirect('/ftp/login.html')
        return;
    }
    res.sendFile(__dirname + '/index.html');
})

app.post(API_PATH + 'login', function (req, res) {
    if (req.session.ftp_connection) {
        if (req.session.ftp_connection.flag) {
            req.session.ftp_connection.client.end();
        }
    }
    var user = req.body;
    console.log(user);
    req.session.ftp_connection = true;
    var ftp = createFtp(req.session.id);
    client_map.set(ftp.id,ftp);
    ftp.client.on('ready', function () {
        res.json(createRes("success"));
    })
    ftp.client.on('error', function (err) {
        if(client_map.has(ftp.id)){
            client_map.delete(ftp.id);
        }
        console.log(err);
        if (err.code == 530) {
            res.json(createRes("Login failed", err));
        }
    })
    ftp.client.on('close', function (err) {
        if(client_map.has(ftp.id)){
            client_map.delete(ftp.id);
        }
    })
    ftp.client.on('end', function (err) {
        if(client_map.has(ftp.id)){
            client_map.delete(ftp.id);
        }
    })
    ftp.client.connect({ user: user.user, password: user.password });
})

app.use(API_PATH, function (req, res, next) {
    if (req.session.ftp_connection) {
        var index = req.session.id;
        if (client_map.has(index)) {
            next();
        }
    }
    res.json(createRes('Need login'));
})



app.get(API_PATH + 'get_dir', function (req, res) {
    var index=req.session.id;
    var ftp=client_map.get(index);
    ftp.client.list(function (err, list) {
        if (err) {
            res.json(createRes("Error", err));
        } else {
            res.json(createRes("success", list));
        }
    })
})

app.listen(9090, function () {
    console.log('listen to port 9090');
})

function createFtp(index) {
    var ftp = new Object();
    ftp.client = new Client();
    ftp.id = index;
    return ftp;
}

function createRes(message, result) {
    var res = new Object();
    if (message) {
        res.message = message;
    }
    if (result) {
        res.result = result;
    }
    return res;
}
