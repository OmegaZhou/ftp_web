const express = require('express')
const session = require('express-session')
const body_parser = require('body-parser')
const requestIp = require('request-ip');
const multer = require('multer')
const api = require('./lib/api')
const upload = multer({ dest: './upload_tmp' });
const createRes = api.createRes;
const API_PATH = '/ftp/api/'
var app = express();
var client_map = api.client_map;
api.init(app, {max_age : 1000*60*60, max_try : 3})
app.use(session({
    secret: 'ftp_web',
    cookie: {
        maxAge: 60 * 1000 * 30
    },
    saveUninitialized: false,
    resave: false,

}))
app.use(requestIp.mw())
app.use(API_PATH+'login',api.limitLoginTime)
app.use('/ftp/img', express.static(__dirname + '/img'))
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/ftp/js', express.static(__dirname + '/js'))


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

app.post(API_PATH + 'login', api.login)
app.get(API_PATH + "pub_rsa", api.get_pub_rsa)
app.use(API_PATH, function (req, res, next) {
	console.log("mid",req.session.ftp_connection)
    if (req.session.ftp_connection) {
        var index = req.session.id;
        if (client_map.has(index)) {
            next();
        }
    } else {
        res.json(createRes('Need login'));
    }

})



app.get(API_PATH + 'get_dir', api.getDir)

app.get(API_PATH + 'pwd', api.pwd)

app.post(API_PATH + 'change_dir', api.cwd);

app.get(API_PATH + 'download/:path', api.download);

app.post(API_PATH + 'upload', upload.single('file'), api.upload)
app.post(API_PATH + 'mkdir', api.mkdir);
app.post(API_PATH + 'rename', api.rename);
app.post(API_PATH + 'rmdir', api.rmdir);
app.post(API_PATH + 'delete_file', api.delete_file);
app.get(API_PATH + 'logout', function (req, res) {
    var index = req.session.id;
    if (client_map.has(index)) {
        var ftp = client_map.get(index);
        ftp.client.end();
        client_map.delete(index)
    }
    req.session.destroy(success => {
        res.json(createRes("success", success))
    });
})
app.listen(9090, function () {
    console.log('listen to port 9090');
})




