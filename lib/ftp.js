const Client=require('ftp')
const error=require('./error')
var ftp=new Client();

exports.getDir=function(user,callback){
    ftp.on('ready',function(){
        ftp.list(function(err,list){
            callback(err,list)
            ftp.end();
        })
    })
    ftp.connect({user:user.user,password:user.password});
}

exports.getFile=function(user,callback){
    
}