var fs=require('fs');
var time_data=require('./time')
const ERR_PATH = '../error.log'
function error(message){
    fs.appendFile(ERR_PATH, time_data.getTime()+'\n'+message + '\n', err => {
        if (err) {
            console.log(err);
        }
    });
    return Promise.resolve();
}

exports.error=error;