const Client = require('ftp')
const fs = require('fs')
const NodeRSA = require("node-rsa")
const error=require('./error')

var client_map = new Map();
exports.client_map = client_map;
const private_key = new NodeRSA(fs.readFileSync("./pri_key.rsa"));
private_key.setOptions({encryptionScheme: 'pkcs1'});
class AccessRecord
{
    constructor()
    {
        this.latest_access_time = Date.now()
        this.try_time = 0
    }
    canAccess(max_try)
    {
        return Math.max(0, max_try - this.try_time) 
    }
    tryFail()
    {
        this.try_time += 1
        this.latest_access_time = Date.now()
    }
    isExpired(max_age)
    {
        return this.latest_access_time + max_age < Date.now()
    }
    remainTime(max_age)
    {
        return this.latest_access_time + max_age - Date.now()
    }
}
class IpRecordManager
{
    // 单位:毫秒
    constructor(max_age, max_try) {
        this.access_info = new Map()
        this.max_age = max_age
        this.max_try = max_try
        setInterval(() => {
            this.clearExpiredRecord()
        }, 1000*60*60);
    }
    get(ip){
        return this.access_info.get(ip)
    }
    expireRecord(ip)
    {
        var record = this.access_info.get(ip)
        if(!record){
            return true 
        }else{
            if(record.isExpired(this.max_age)){
                this.access_info.delete(ip)
                return true
            }else{
                return false
            }
        } 
    }
    tryFail(ip){
        if(this.expireRecord(ip)){
            this.access_info.set(ip, new AccessRecord())
        }
        var record = this.get(ip)
        record.tryFail()
    }
    canAccess(ip){
        if(this.expireRecord(ip)){
            return this.max_try;
        }else{
            var record = this.get(ip)
            return record.canAccess(this.max_try)
        }
    }
    remainTime(ip){
        if(this.expireRecord(ip)){
            return 0;
        }else{
            var record = this.get(ip)
            return record.remainTime(this.max_age)
        }
    }
    clearExpiredRecord(){
        var keys = []
        for(var item of this.access_info){
            var key = item[0]
            var value = item[1]
            if(value.isExpired(this.max_age)){
                keys.push(key)
            }
        }
        for(key of keys){
            this.access_info.delete(key)
        }
    }
}
exports.init = (app, ip_access_config)=>{
    app.locals.ip_record = new IpRecordManager(ip_access_config.max_age, ip_access_config.max_try)
}


exports.limitLoginTime = (req,res,next)=>{
    var ip_record = req.app.locals.ip_record
    const clientIp = req.clientIp; 
    if(ip_record.canAccess(clientIp)){
        next()
    }else{
        var remain_time = ip_record.remainTime(clientIp) / 1000 / 60
        res.json(createRes(`Please login after ${remain_time} min`))
    }
}
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
            req.app.locals.ip_record.tryFail(req.clientIp)
            var remain = req.app.locals.ip_record.canAccess(req.clientIp)
            res.json(createRes(`Login failed, remain ${remain} times`, remain));
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
