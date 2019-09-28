const express = require('express')
const session = require('express-session')
const body_parser = require('body-parser')
const multer=require('multer')
const api=require('./lib/api')
const upload=multer({dest:'./upload_tmp'});
const createRes=api.createRes;
const API_PATH = '/ftp/api/'
var app = express();
var client_map=api.client_map;
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

} )

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

app.post(API_PATH + 'login',api.login )

app.use(API_PATH, function (req, res, next) {
    if (req.session.ftp_connection) {
        var index = req.session.id;
        if (client_map.has(index)) {
            next();
        }
    }else{
        res.json(createRes('Need login'));
    }
    
})



app.get(API_PATH + 'get_dir', api.getDir)

app.get(API_PATH+'pwd',api.pwd)

app.post(API_PATH+'change_dir',api.cwd);

app.get(API_PATH+'download/:path',api.download);

app.post(API_PATH+'upload',upload.single('file'),api.upload)
app.post(API_PATH+'mkdir',api.mkdir);
app.get(API_PATH+'logout',function(req,res){
    var index = req.session.id;
    if (client_map.has(index)) {
        var ftp = client_map.get(index);
        ftp.client.end();
        client_map.delete(index)
    }
    req.session.destroy(success=>{
        res.json(createRes("success",success))
    });
})
app.listen(9090, function () {
    console.log('listen to port 9090');
})




