const Client = require('ftp')
const fs = require('fs')
const NodeRSA = require("node-rsa")
const error=require('./error')

var client_map = new Map();
exports.client_map = client_map;
const private_key = new NodeRSA(fs.readFileSync("./pri_key.rsa"));
private_key.setOptions({encryptionScheme: 'pkcs1'});
exports.login = function (req, res) {
    if (req.session.ftp_connection) {
        if (req.session.ftp_connection.flag) {
            req.session.ftp_connection.client.end();
        }
    }
    var user = req.body;
    decrypt(user)
    //console.log(user);
    req.session.ftp_connection = true;
    var ftp = createFtp(req.session.id);
    client_map.set(ftp.id, ftp);
    ftp.client.on('ready', function () {
        res.json(createRes("success"));
    })
    ftp.client.on('error', function (err) {
        if (client_map.has(ftp.id)) {
            client_map.get(ftp.id).client.end();
            client_map.delete(ftp.id);
        }
        error.error(err);
        if (err.code == 530) {
            res.json(createRes("Login failed", err.code));
        }
    })
    ftp.client.on('close', function (err) {
        if (client_map.has(ftp.id)) {
            client_map.delete(ftp.id);
        }
    })
    ftp.client.on('end', function (err) {
        if (client_map.has(ftp.id)) {
            client_map.delete(ftp.id);
        }
    })
    ftp.client.connect({ user: user.user, password: user.password });
}

exports.getDir = function (req, res) {
    var index = req.session.id;
    var ftp = client_map.get(index);
    ftp.client.list(function (err, list) {
        if (err) {
            error.error(err);
            res.json(createRes("Error", err));
        } else {
            //console.log(list)
            for (var i = 0; i < list.length; ++i) {
                list[i].name = Buffer.from(list[i].name.toString(), 'binary').toString('utf-8');
            }
            res.json(createRes("success", list));
        }
    })
}

exports.pwd = function (req, res) {
    var index = req.session.id;
    var ftp = client_map.get(index);
    ftp.client.pwd(function (err, data) {
        if (err) {
            error.error(err);
            res.json(createRes("Error", err.code));
        } else {
            res.json(createRes("success", Buffer.from(data, 'binary').toString('utf8')));
        }
    })
}

exports.cwd = function (req, res) {
    var index = req.session.id;
    var ftp = client_map.get(index);
    var path = req.body.path;
    ftp.client.cwd(path.toString(), function (err, data) {
        if (err) {
            error.error(err);
            res.json(createRes("Error", err.code));
        } else {
            //console.log(data)
            res.json(createRes("success", data));
        }
    })
}

exports.download = function (req, res) {
	console.log("download")
    var index = req.session.id;
    var ftp = client_map.get(index);
    var path = decodeURIComponent(req.params.path)
    console.log(path)
    ftp.client.get(path, function (err, data) {
        if (err) {
            res.status(404);
        } else {
            //console.log('a')
            //console.log(data)
            res.writeHead(200, {
                'Content-Type': 'application/force-download'
            });
            data.pipe(res);
        }
    })
}

exports.mkdir = function (req, res) {
    var index = req.session.id;
    var ftp = client_map.get(index);
    var path = req.body.path;
    //console.log(path);
    ftp.client.mkdir(path, function (err) {
        if (err) {
            error.error(err);
            res.json(createRes("Error", err.code));
        } else {
            //console.log(data)
            res.json(createRes("success"));
        }
    })
}

exports.upload = function (req, res) {
    var index = req.session.id;
    var ftp = client_map.get(index);
    var path = req.body.path;
    var name = req.body.name;
    var origin = req.file;
    ftp.client.put(origin.path, path+name, function (err) {
        //console.log(origin)
        //console.log(path+name)
        //console.log(err);
        if (err) {
            fs.unlink(origin.path, err => {
            })
            res.json(createRes("Error", err.code));
        } else {
            fs.unlink(origin.path, err => {
            })
            //console.log(data)
            res.json(createRes("success"));
        }
    })
}

exports.delete_file=function(req,res){
    var index = req.session.id;
    var ftp = client_map.get(index);
    var path = req.body.path;
    ftp.client.delete(path,function(err){
        if (err) {
            res.json(createRes("Error", err.code));
        } else {
            //console.log(data)
            res.json(createRes("success"));
        }
    })
}

exports.rmdir=function(req,res){
    var index = req.session.id;
    var ftp = client_map.get(index);
    var path = req.body.path;
    ftp.client.rmdir(path,true,function(err){
        if (err) {
		console.log(err);
            res.json(createRes("Error", err.code));
        } else {
            //console.log(data)
            res.json(createRes("success"));
        }
    })
}

exports.rename=function(req,res){
    var index = req.session.id;
    var ftp = client_map.get(index);
    var old_path=req.body.old_path
    var new_path = req.body.new_path;
    //console.log(old_path,new_path);
    ftp.client.rename(old_path,new_path,function(err){
        if (err) {
            res.json(createRes("Error", err.code));
        } else {
            //console.log(data)
            res.json(createRes("success"));
        }
    })
}

exports.get_pub_rsa=function(req,res){
    var pub_key = fs.readFileSync("./pub_key.rsa")
    res.send(pub_key)
}

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

function decrypt(user){
    user.user = private_key.decrypt(user.user)
    user.password = private_key.decrypt(user.password)
    console.log(user)
}
exports.createRes = createRes;
